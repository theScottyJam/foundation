import { buildErrorWithUnderlinedText } from './errorFormatter.ts';
import type { InternalBody, ReadyValue, Value } from './runtime.ts';
import type { Range } from './shared.ts';
import { RESERVED_CHARS, Tokenizer } from './Tokenizer.ts';
import { throwIndexOutOfBounds } from './util.ts';

export interface AstNodeBase {
  readonly range: Range
}

export interface FnNode extends AstNodeBase {
  readonly category: 'fn'
  readonly defId: symbol
  // Not readonly - can be modified if a better name is found
  name: string
  readonly fnRefName: IdentifierNode | undefined
  readonly param: IdentifierNode
  readonly body: ExpressionNode | InternalBody
}

export interface FnCallNode extends AstNodeBase {
  readonly category: 'fnCallNode'
  readonly beingCalled: ExpressionNode
  readonly arg: ExpressionNode
}

/** Not directly used by the parser, instead, this is used to aid in building a stdlib. */
export interface BuiltinFnCallNode extends AstNodeBase {
  readonly category: 'builtinFnCallNode'
  readonly beingCalled: ReadyValue
  readonly arg: Value
}

export interface DeclarationBlockNode extends AstNodeBase {
  readonly category: 'declarationBlock'
  readonly declarations: {
    readonly identifier: IdentifierNode
    readonly bindValue: ExpressionNode
  }[]
  readonly finalExpression: ExpressionNode
}

export interface IdentifierNode extends AstNodeBase {
  readonly category: 'identifier'
  readonly identifier: string
}

export type ExpressionNode = FnNode | FnCallNode | IdentifierNode | DeclarationBlockNode;

interface ParseContext {
  readonly tokenizer: Tokenizer
  readonly reportError: (message: string, range: Range) => never
  readonly assertToken: (ctx: ParseContext, tokens: string[]) => void
  readonly fnRefNameToFnNode: Map<string, FnNode>
}

export interface ParseResult {
  readonly rootNode: ExpressionNode
  readonly fnRefNameToFnNode: Map<string, FnNode>
}

export const KEYWORDS = ['fn', 'let', 'in'];

export function parse(text: string): ParseResult {
  const ctx: ParseContext = {
    tokenizer: new Tokenizer(text),
    reportError: (message: string, range: Range) => {
      throw new Error(buildErrorWithUnderlinedText(message, {
        fileContents: text,
        start: range.start.index,
        end: range.end.index,
      }));
    },
    assertToken: (ctx: ParseContext, tokenValues: string[]) => {
      if (!tokenValues.includes(ctx.tokenizer.peek().value)) {
        ctx.reportError(`Expected "${ctx.tokenizer.peek().value}" to be one of ${tokenValues.map(t => `"${t}"`).join(', ')}.`, {
          start: ctx.tokenizer.peek().range.start,
          end: ctx.tokenizer.peek().range.end,
        });
      }
    },
    fnRefNameToFnNode: new Map(),
  };

  return {
    rootNode: parseExpression(ctx),
    fnRefNameToFnNode: ctx.fnRefNameToFnNode,
  };
}

function parseExpression(ctx: ParseContext): ExpressionNode {
  let expressionNode: ExpressionNode;
  if (ctx.tokenizer.peek().value === 'fn') {
    expressionNode = parseFunction(ctx);
  } else if (ctx.tokenizer.peek().value === 'let') {
    expressionNode = parseDeclarationBlock(ctx);
  } else if (nextTokenIsValidIdentifier(ctx)) {
    expressionNode = parseIdentifier(ctx, { allowPounds: true });
  } else {
    ctx.reportError('Expected to find an expression', ctx.tokenizer.peek().range);
  }

  while (ctx.tokenizer.peek().value === '(') {
    for (const arg of parseArgumentList(ctx)) {
      const fnCallNode: FnCallNode = {
        category: 'fnCallNode',
        beingCalled: expressionNode,
        arg,
        range: {
          start: expressionNode.range.start,
          end: arg.range.end,
        },
      };
      expressionNode = fnCallNode;
    }
  }

  return expressionNode;
}

function parseDeclarationBlock(ctx: ParseContext): ExpressionNode {
  const firstToken = ctx.tokenizer.peek();
  const declarations: { identifier: IdentifierNode, bindValue: ExpressionNode }[] = [];
  while (true) {
    ctx.assertToken(ctx, ['let']);
    ctx.tokenizer.next();

    const identifier = parseIdentifier(ctx);

    ctx.assertToken(ctx, ['=']);
    ctx.tokenizer.next();

    const bindValue = parseExpression(ctx);
    let maybeFn: ExpressionNode | InternalBody = bindValue;
    while (maybeFn.category === 'fn') {
      maybeFn.name = maybeFn === bindValue ? identifier.identifier : `<partially applied "${identifier.identifier}">`;
      maybeFn = maybeFn.body;
    }

    declarations.push({ identifier, bindValue });
    if (ctx.tokenizer.peek().value === 'in') {
      break;
    }
  }

  ctx.assertToken(ctx, ['in']);
  ctx.tokenizer.next();

  ctx.assertToken(ctx, ['{']);
  ctx.tokenizer.next();

  const finalExpression = parseExpression(ctx);

  ctx.assertToken(ctx, ['}']);
  ctx.tokenizer.next();

  return {
    category: 'declarationBlock',
    declarations,
    finalExpression,
    range: {
      start: firstToken.range.start,
      end: finalExpression.range.end,
    },
  };
}

function parseFunction(ctx: ParseContext): FnNode {
  const start = ctx.tokenizer.peek().range.start;

  ctx.assertToken(ctx, ['fn']);
  ctx.tokenizer.next();

  let fnRefName: IdentifierNode | undefined;
  if (ctx.tokenizer.peek().value === '#') {
    const poundToken = ctx.tokenizer.next();
    if (!nextTokenIsValidIdentifier(ctx)) {
      ctx.reportError('Expected an identifier after the "#"', poundToken.range);
    }
    fnRefName = parseIdentifier(ctx);
  }

  ctx.assertToken(ctx, ['(']);
  ctx.tokenizer.next();
  if (ctx.tokenizer.peek().value === ')') {
    ctx.reportError('Functions must have at least one parameter', { start, end: ctx.tokenizer.peek().range.end });
  }

  const params: IdentifierNode[] = [];
  while (true) {
    const identifierNode = parseIdentifier(ctx);
    params.push(identifierNode);
    const commaFound = ctx.tokenizer.peek().value === ',';
    if (commaFound) {
      ctx.tokenizer.next();
    }
    if (ctx.tokenizer.peek().value === ')') {
      ctx.tokenizer.next();
      break;
    }
    if (!commaFound) {
      ctx.reportError('This parameter should have a comma after it.', params.at(-1)!.range);
    }
  }

  ctx.assertToken(ctx, ['{']);
  ctx.tokenizer.next();

  const body = parseExpression(ctx);

  ctx.assertToken(ctx, ['}']);
  ctx.tokenizer.next();

  const range = {
    start,
    end: body.range.end,
  };

  let result: FnNode = {
    category: 'fn',
    defId: Symbol('<partially applied fn>'),
    name: '<partially applied fn>',
    fnRefName: undefined,
    param: params.at(-1) ?? throwIndexOutOfBounds(),
    body,
    range,
  };
  for (const param of [...params].slice(0, -1).reverse()) {
    result = {
      category: 'fn',
      defId: Symbol('<partially applied fn>'),
      name: '<partially applied fn>',
      fnRefName: undefined,
      param,
      body: result,
      range,
    };
  }

  const fnNode: FnNode = {
    ...result,
    defId: Symbol('<fn>'),
    name: '<anonymous fn>',
    fnRefName,
  };

  if (fnRefName !== undefined) {
    if (ctx.fnRefNameToFnNode.has(fnRefName.identifier)) {
      ctx.reportError('Multiple functions cannot have the same reference ID', fnRefName.range);
    }
    ctx.fnRefNameToFnNode.set(fnRefName.identifier, fnNode);
  }

  return fnNode;
}

function parseArgumentList(ctx: ParseContext): FnCallNode['arg'][] {
  const start = ctx.tokenizer.peek().range.start;

  ctx.assertToken(ctx, ['(']);
  ctx.tokenizer.next();

  if (ctx.tokenizer.peek().value === ')') {
    ctx.reportError('Functions must have at least one argument', { start, end: ctx.tokenizer.peek().range.end });
  }

  const args: ExpressionNode[] = [];
  while (true) {
    args.push(parseExpression(ctx));
    const commaFound = ctx.tokenizer.peek().value === ',';
    if (commaFound) {
      ctx.tokenizer.next();
    }
    if (ctx.tokenizer.peek().value === ')') {
      ctx.tokenizer.next();
      break;
    }
    if (!commaFound) {
      ctx.reportError('This argument should have a comma after it.', args.at(-1)!.range);
    }
  }

  return args;
}

function parseIdentifier(ctx: ParseContext, opts: { allowPounds?: boolean } = {}): IdentifierNode {
  if (!nextTokenIsValidIdentifier(ctx)) {
    ctx.reportError('Expected to find an identifier', ctx.tokenizer.peek().range);
  }

  const identifierToken = ctx.tokenizer.next();

  if (opts.allowPounds === true && identifierToken.value === 'is' && ctx.tokenizer.peek().value === '#') {
    ctx.tokenizer.next();
    const fnRefNameIdentifier = parseIdentifier(ctx);

    return {
      category: 'identifier',
      identifier: identifierToken.value + '#' + fnRefNameIdentifier.identifier,
      range: {
        start: identifierToken.range.start,
        end: fnRefNameIdentifier.range.end,
      },
    };
  } else {
    return {
      category: 'identifier',
      identifier: identifierToken.value,
      range: identifierToken.range,
    };
  }
}

function nextTokenIsValidIdentifier(ctx: ParseContext): boolean {
  const nextTokenValue = ctx.tokenizer.peek().value;
  return !RESERVED_CHARS.includes(nextTokenValue) && !KEYWORDS.includes(nextTokenValue);
}
