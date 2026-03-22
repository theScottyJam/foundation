import { buildErrorWithUnderlinedText } from './errorFormatter.ts';
import type { Range } from './shared.ts';
import { EOF, RESERVED_CHARS, Tokenizer } from './Tokenizer.ts';
import { throwIndexOutOfBounds } from '../util.ts';
import type { ParseContext, VarDef, IdentifierNode, Relationship, MutableRelationship } from './parserTools.ts';
import * as tools from './parserTools.ts';
import { registerStdLibLinks } from './stdLibLinks.ts';

interface BedrockData {
  readonly relationships: Record<string, string>[]
  readonly links: Record<string, string>
}

export const KEYWORDS = ['def', 'with'];

export function parse(text: string): BedrockData {
  const ctx_: Omit<ParseContext, 'stdLibLinks'> = {
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

      // Returns a commonly-used follow-on action, to allow it to be easily chained if wanted.
      return {
        next: () => ctx.tokenizer.next(),
      };
    },
    varIdToLabel: new Map(),
    links: new Map(),
    scopes: [{ labelToDef: new Map() }],
    nextId: 0,
  };

  const stdLibLinks = registerStdLibLinks(ctx_);
  const ctx = { ...ctx_, stdLibLinks };

  const relationships = parseStatementList(ctx, { endAt: EOF });

  const transformId = (id: number) => {
    if (id === ctx.stdLibLinks.relationshipTypeId) {
      return 'type';
    }
    const label = ctx.varIdToLabel.get(id);
    return label === undefined ? String(id) : `${id}:${label}`;
  };

  return {
    relationships: relationships.map(relationship => {
      return Object.fromEntries(
        [...relationship.entries()].map(([key, value]) => [transformId(key), transformId(value)]),
      );
    }),
    links: Object.fromEntries(
      [...ctx.links.entries()].map(([key, value]) => [transformId(key), value]),
    ),
  };
}

/** endAt support being set to {@link EOF} */
function parseStatementList(ctx: ParseContext, opts: { endAt: string }): Relationship[] {
  const result: Relationship[] = [];
  while (ctx.tokenizer.peek().value !== opts.endAt) {
    result.push(...parseStatement(ctx));
  }
  return result;
}

function parseStatement(ctx: ParseContext): Relationship[] {
  if (ctx.tokenizer.peek().value === 'def') {
    return parseDefinition(ctx);
  }

  const { relationships, returnedVarId } = parseExpression(ctx, { inStatementPos: true });
  return [
    ...relationships,
    ctx.stdLibLinks.createRule(returnedVarId),
  ];
}

function parseDefinition(ctx: ParseContext): Relationship[] {
  ctx.assertToken(ctx, ['def']).next();

  const identifierNode = parseIdentifier(ctx);
  const id = tools.genNextVarId(ctx);

  if (identifierNode.identifier === 'self') {
    ctx.reportError('Cannot declare a variable named "self" - it is reserved.', identifierNode.range);
  }

  const currentScope = ctx.scopes.at(-1) ?? throwIndexOutOfBounds();
  if (currentScope.labelToDef.has(identifierNode.identifier)) {
    ctx.reportError('This identifier has been declared twice in the same scope.', identifierNode.range);
  }

  const def: VarDef = { id, label: identifierNode.identifier, varsInScope: new Map() };
  currentScope.labelToDef.set(identifierNode.identifier, def);
  ctx.varIdToLabel.set(id, identifierNode.identifier);

  if (ctx.tokenizer.peek().value !== 'with') {
    return [];
  }
  ctx.tokenizer.next();

  return tools.enterScope(
    ctx,
    {
      labelToDef: new Map([
        ['self', def],
      ]),
    },
    () => {
      ctx.assertToken(ctx, ['{']).next();
      const result = parseStatementList(ctx, { endAt: '}' });
      ctx.assertToken(ctx, ['}']).next();
      return result;
    },
  );
}

interface ExpressionNode {
  readonly relationships: Relationship[]
  readonly returnedVarId: number
  readonly range: Range
}

function parseExpression(ctx: ParseContext, opts: { inStatementPos?: boolean } = {}): ExpressionNode {
  const { inStatementPos = false } = opts;

  if (nextTokenIsValidIdentifier(ctx)) {
    const identifierNode = parseIdentifier(ctx);
    if (ctx.tokenizer.peek().value === '(') {
      return parseFunctionCall(ctx, identifierNode);
    }
    if (!inStatementPos) {
      const varDef = tools.lookupVar(ctx, identifierNode);
      return { relationships: [], returnedVarId: varDef.id, range: identifierNode.range };
    }
    ctx.reportError('Expected a statement here.', identifierNode.range);
  }

  ctx.reportError('Expected a statement here.', ctx.tokenizer.peek().range);
}

/** Parses the `(a=1, b=2)->c` of `myFn(a=1, b=2)->c`. */
function parseFunctionCall(ctx: ParseContext, fnNameNode: IdentifierNode): ExpressionNode {
  const fnDef = tools.lookupVar(ctx, fnNameNode);

  const start = ctx.tokenizer.peek().range.start;

  ctx.assertToken(ctx, ['(']).next();

  if (ctx.tokenizer.peek().value === ')') {
    ctx.reportError('Functions must have at least one argument', { start, end: ctx.tokenizer.peek().range.end });
  }

  const childRelationships: Relationship[] = [];
  const relationship: MutableRelationship = new Map();
  relationship.set(ctx.stdLibLinks.relationshipTypeId, fnDef.id);

  return tools.enterScope(
    ctx,
    {
      // TODO: In the future it would (probably) be better if the only items in scope was whatever the function provided. Right now
      // you can use anything from outer scopes as well as keys.
      labelToDef: new Map(fnDef.varsInScope),
    },
    () => {
      while (true) {
        const keyNode = parseIdentifier(ctx);
        const keyDef = tools.lookupVar(ctx, keyNode);
        ctx.assertToken(ctx, ['=']).next();
        const valueNode = parseExpression(ctx);
        if (relationship.has(keyDef.id)) {
          ctx.reportError('This same key got used in this relationship multiple times.', keyNode.range);
        }
        relationship.set(keyDef.id, valueNode.returnedVarId);
        childRelationships.push(...valueNode.relationships);

        const commaFound = ctx.tokenizer.peek().value === ',';
        if (commaFound) {
          ctx.tokenizer.next();
        }
        if (ctx.tokenizer.peek().value === ')') {
          ctx.tokenizer.next();
          break;
        }
        if (!commaFound) {
          const range: Range = { start: keyNode.range.start, end: valueNode.range.end };
          ctx.reportError('This argument should have a comma after it.', range);
        }
      }

      ctx.assertToken(ctx, ['-']).next();
      ctx.assertToken(ctx, ['>']).next();

      const returnParamName = parseIdentifier(ctx);
      const returnParamDef = tools.lookupVar(ctx, returnParamName);
      const outputVarId = tools.genNextVarId(ctx);

      if (relationship.has(returnParamDef.id)) {
        ctx.reportError('This same key got used in this relationship multiple times.', returnParamName.range);
      }
      relationship.set(returnParamDef.id, outputVarId);

      return {
        relationships: [...childRelationships, relationship],
        returnedVarId: outputVarId,
        range: { start, end: returnParamName.range.end },
      };
    },
  );
}

function parseIdentifier(ctx: ParseContext): IdentifierNode {
  if (!nextTokenIsValidIdentifier(ctx)) {
    ctx.reportError('Expected to find an identifier', ctx.tokenizer.peek().range);
  }

  const identifierToken = ctx.tokenizer.next();

  return {
    identifier: identifierToken.value,
    range: identifierToken.range,
  };
}

function nextTokenIsValidIdentifier(ctx: ParseContext): boolean {
  const nextTokenValue = ctx.tokenizer.peek().value;
  return !RESERVED_CHARS.includes(nextTokenValue) && !KEYWORDS.includes(nextTokenValue);
}
