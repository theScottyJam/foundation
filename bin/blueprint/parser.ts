// TODO: I'm not really handling unexpected EOF errors very well.
import type { BedrockData, Position, Range } from '../types.ts';
import { EOF, RESERVED_CHARS, Tokenizer, type Token } from './Tokenizer.ts';
import { assert, throwIndexOutOfBounds } from '../util.ts';
import type { ParseContext, VarDef, IdentifierNode, Relationship, MutableRelationship, IdentifierSeries } from './parserTools.ts';
import * as tools from './parserTools.ts';
import { getStdLibLinks } from './stdLibLinks.ts';

export const KEYWORDS = ['def', 'link'];

export function parse(text: string): BedrockData {
  const globalScope = { labelToDef: new Map() };
  const ctx: ParseContext = {
    tokenizer: new Tokenizer(text),
    varIdToLabel: new Map(),
    links: new Map(),
    globalScope,
    scopes: [globalScope],
    stdLibLinks: getStdLibLinks(),
    nextId: 0,
    relationships: [],
  };

  parseStatementList(ctx, { endAt: EOF });

  const transformId = (id: number) => {
    const label = ctx.varIdToLabel.get(id);
    return label === undefined ? String(id) : `${id}:${label}`;
  };

  return {
    sourceText: text,
    relationships: ctx.relationships.map(relationship => {
      return {
        type: transformId(relationship.type),
        mapping: Object.fromEntries(
          [...relationship.mapping.entries()].map(([key, value]) => [transformId(key), transformId(value)]),
        ),
        range: relationship.range,
      };
    }),
    links: Object.fromEntries(
      [...ctx.links.entries()].map(([key, value]) => [key, transformId(value)]),
    ),
  };
}

/** endAt support being set to {@link EOF} */
function parseStatementList(ctx: ParseContext, opts: { endAt: string }): void {
  while (ctx.tokenizer.peek().value !== opts.endAt) {
    parseStatement(ctx);
  }
}

function parseStatement(ctx: ParseContext): void {
  if (ctx.tokenizer.peek().value === 'def') {
    parseDefinition(ctx);
    return;
  }
  if (ctx.tokenizer.peek().value === 'link') {
    parseLink(ctx);
    return;
  }

  tools.addRelationships(ctx, parseExpressionInStatementPos(ctx));
}

function parseDefinition(ctx: ParseContext): void {
  tools.assertToken(ctx, ['def']).next();

  const identifierNode = parseIdentifier(ctx);
  const id = tools.genNextVarId(ctx);

  if (identifierNode.identifier === 'self') {
    tools.reportError(ctx, 'Cannot declare a variable named "self" - it is reserved.', identifierNode.range);
  }

  const currentScope = ctx.scopes.at(-1) ?? throwIndexOutOfBounds();
  if (currentScope.labelToDef.has(identifierNode.identifier)) {
    tools.reportError(ctx, 'This identifier has been declared twice in the same scope.', identifierNode.range);
  }

  const def: VarDef = { id, label: identifierNode.identifier, varsInModule: new Map() };
  currentScope.labelToDef.set(identifierNode.identifier, def);
  ctx.varIdToLabel.set(id, identifierNode.identifier);

  // Adding `self` is useful if you're in the module and wish to reference itself.
  // It's a little unfortunate that this also make it so you can do theModule.self. Not something I'll worry about for now.
  def.varsInModule.set('self', def);

  if (ctx.tokenizer.peek().value !== '{') {
    return;
  }

  tools.enterScope(
    ctx,
    {
      // If labelToDef is mutated and items are added, they'll be added to def.varsInModule.
      labelToDef: def.varsInModule,
    },
    () => {
      tools.assertToken(ctx, ['{']).next();
      parseStatementList(ctx, { endAt: '}' });
      tools.assertToken(ctx, ['}']).next();
    },
  );
}

function parseLink(ctx: ParseContext) {
  const start = ctx.tokenizer.peek().range.start;
  tools.assertToken(ctx, ['link']).next();

  let uuid = '';
  let end!: Position;
  while (true) {
    end = ctx.tokenizer.peek().range.end;
    uuid += ctx.tokenizer.next().value;
    if (ctx.tokenizer.peek().value === '-') {
      ctx.tokenizer.next();
      uuid += '-';
    } else {
      break;
    }
  }

  const varDef = tools.tryLookupVar(ctx, 'self');
  if (varDef === undefined) {
    tools.reportError(ctx, 'Can only use the "link" syntax inside a var def', { start, end });
  }
  if (ctx.links.has(uuid)) {
    tools.reportError(ctx, 'This UUID has been defined on multiple entities.', { start, end });
  }

  ctx.links.set(uuid, varDef.id);
}

interface ExpressionNode {
  readonly relationships: Relationship[]
  readonly returnedVarId: number
  readonly range: Range
}

function parseExpression_(
  ctx: ParseContext,
  opts: { inStatementPos: boolean },
): Omit<ExpressionNode, 'returnedVarId'> & { returnedVarId: number | undefined } {
  const { inStatementPos = false } = opts;

  if (nextTokenIsValidIdentifier(ctx)) {
    const identifierSeries = parseIdentifierSeries(ctx);
    if (ctx.tokenizer.peek().value === '(') {
      return parseFunctionCall(ctx, identifierSeries, { inStatementPos });
    }
    if (!inStatementPos) {
      const varDef = tools.lookupVarSeries(ctx, identifierSeries);
      return { relationships: [], returnedVarId: varDef.id, range: identifierSeries.range };
    }
    tools.reportError(ctx, 'Expected a statement here.', identifierSeries.range);
  }

  tools.reportError(ctx, 'Expected a statement here.', ctx.tokenizer.peek().range);
}

function parseExpression(ctx: ParseContext): ExpressionNode {
  const result = parseExpression_(ctx, { inStatementPos: false });
  assert(result.returnedVarId !== undefined);
  return result as ExpressionNode;
}

function parseExpressionInStatementPos(ctx: ParseContext): Relationship[] {
  const result = parseExpression_(ctx, { inStatementPos: true });
  assert(result.returnedVarId === undefined);
  return result.relationships;
}

/** Parses the `(a=1, b=2)->c` of `myFn(a=1, b=2)->c`. */
function parseFunctionCall(
  ctx: ParseContext,
  fnNameSeries: IdentifierSeries,
  opts: { inStatementPos: boolean },
): Omit<ExpressionNode, 'returnedVarId'> & { returnedVarId: number | undefined } {
  const fnDef = tools.lookupVarSeries(ctx, fnNameSeries);

  const start = fnNameSeries.range.start;

  tools.assertToken(ctx, ['(']).next();

  if (ctx.tokenizer.peek().value === ')') {
    tools.reportError(ctx, 'Functions must have at least one argument', { start, end: ctx.tokenizer.peek().range.end });
  }

  const childRelationships: Relationship[] = [];
  const relationship: MutableRelationship = {
    type: fnDef.id,
    mapping: new Map(),
  };

  const keyScope: tools.Scope = {
    labelToDef: new Map(fnDef.varsInModule),
  };

  let endParenToken: Token;
  while (true) {
    const keyNode = parseIdentifierSeries(ctx);
    const keyDef = tools.replaceScope(ctx, keyScope, () => {
      return tools.lookupVarSeries(ctx, keyNode);
    });
    tools.assertToken(ctx, ['=']).next();
    const valueNode = parseExpression(ctx);
    if (relationship.mapping.has(keyDef.id)) {
      tools.reportError(ctx, 'This same key got used in this relationship multiple times.', keyNode.range);
    }
    relationship.mapping.set(keyDef.id, valueNode.returnedVarId);
    childRelationships.push(...valueNode.relationships);

    const commaFound = ctx.tokenizer.peek().value === ',';
    if (commaFound) {
      ctx.tokenizer.next();
    }
    if (ctx.tokenizer.peek().value === ')') {
      endParenToken = ctx.tokenizer.next();
      break;
    }
    if (!commaFound) {
      const range: Range = { start: keyNode.range.start, end: valueNode.range.end };
      tools.reportError(ctx, 'This argument should have a comma after it.', range);
    }
  }

  if (ctx.tokenizer.peek().value !== '-') {
    const range = { start, end: endParenToken.range.end };
    if (!opts.inStatementPos) {
      tools.reportError(ctx, 'All function calls in expression positions must have an explicit `->xxx` to mark what value should be returned.', range);
    }

    return {
      relationships: [
        ...childRelationships,
        { ...relationship, range },
      ],
      returnedVarId: undefined,
      range,
    };
  }

  tools.assertToken(ctx, ['-']).next();
  tools.assertToken(ctx, ['>']).next();

  const returnParamName = parseIdentifierSeries(ctx);
  const returnParamDef = tools.replaceScope(ctx, keyScope, () => {
    return tools.lookupVarSeries(ctx, returnParamName);
  });

  const range = { start, end: returnParamName.range.end };
  if (opts.inStatementPos) {
    tools.reportError(ctx, 'A function call in a statement position cannot have an explicit `->xxx`, as there isn\'t anything to receive the final value.', range);
  }

  const outputVarId = tools.genNextVarId(ctx);
  if (relationship.mapping.has(returnParamDef.id)) {
    tools.reportError(ctx, 'This same key got used in this relationship multiple times.', returnParamName.range);
  }
  relationship.mapping.set(returnParamDef.id, outputVarId);

  return {
    relationships: [
      ...childRelationships,
      ctx.stdLibLinks.markAsVar(ctx, outputVarId, range),
      { ...relationship, range },
    ],
    returnedVarId: outputVarId,
    range,
  };
}

function parseIdentifierSeries(ctx: ParseContext): IdentifierSeries {
  const series: IdentifierNode[] = [];
  while (true) {
    series.push(parseIdentifier(ctx));
    if (ctx.tokenizer.peek().value === ':') {
      ctx.tokenizer.next();
    } else {
      break;
    }
  }

  return {
    series,
    range: { start: series[0]!.range.start, end: series.at(-1)!.range.end },
  };
}

function parseIdentifier(ctx: ParseContext): IdentifierNode {
  if (!nextTokenIsValidIdentifier(ctx)) {
    tools.reportError(ctx, 'Expected to find an identifier', ctx.tokenizer.peek().range);
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
