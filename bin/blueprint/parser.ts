// TODO: I'm not really handling unexpected EOF errors very well.
import { buildErrorWithUnderlinedText } from './errorFormatter.ts';
import type { Position, Range } from './shared.ts';
import { EOF, RESERVED_CHARS, Tokenizer } from './Tokenizer.ts';
import { throwIndexOutOfBounds } from '../util.ts';
import type { ParseContext, VarDef, IdentifierNode, Relationship, MutableRelationship, IdentifierSeries } from './parserTools.ts';
import * as tools from './parserTools.ts';
import { registerStdLibLinks } from './stdLibLinks.ts';

interface BedrockData {
  readonly relationships: Record<string, string>[]
  readonly links: Record<string, string>
}

export const KEYWORDS = ['def', 'link'];

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
  if (ctx.tokenizer.peek().value === 'link') {
    parseLink(ctx);
    return [];
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

  const def: VarDef = { id, label: identifierNode.identifier, varsInModule: new Map() };
  currentScope.labelToDef.set(identifierNode.identifier, def);
  ctx.varIdToLabel.set(id, identifierNode.identifier);

  // Adding `self` is useful if you're in the module and wish to reference itself.
  // It's a little unfortunate that this also make it so you can do theModule.self. Not something I'll worry about for now.
  def.varsInModule.set('self', def);

  if (ctx.tokenizer.peek().value !== '{') {
    return [];
  }

  return tools.enterScope(
    ctx,
    {
      // If labelToDef is mutated and items are added, they'll be added to def.varsInModule.
      labelToDef: def.varsInModule,
    },
    () => {
      ctx.assertToken(ctx, ['{']).next();
      const result = parseStatementList(ctx, { endAt: '}' });
      ctx.assertToken(ctx, ['}']).next();
      return result;
    },
  );
}

function parseLink(ctx: ParseContext) {
  const start = ctx.tokenizer.peek().range.start;
  ctx.assertToken(ctx, ['link']).next();

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
    ctx.reportError('Can only use the "link" syntax inside a var def', { start, end });
  }
  if ([...ctx.links.values()].some(iterUuid => iterUuid === uuid)) {
    ctx.reportError('This UUID has been defined on multiple entities.', { start, end });
  }

  ctx.links.set(varDef.id, uuid);
}

interface ExpressionNode {
  readonly relationships: Relationship[]
  readonly returnedVarId: number
  readonly range: Range
}

function parseExpression(ctx: ParseContext, opts: { inStatementPos?: boolean } = {}): ExpressionNode {
  const { inStatementPos = false } = opts;

  if (nextTokenIsValidIdentifier(ctx)) {
    const identifierSeries = parseIdentifierSeries(ctx);
    if (ctx.tokenizer.peek().value === '(') {
      return parseFunctionCall(ctx, identifierSeries);
    }
    if (!inStatementPos) {
      const varDef = tools.lookupVarSeries(ctx, identifierSeries);
      return { relationships: [], returnedVarId: varDef.id, range: identifierSeries.range };
    }
    ctx.reportError('Expected a statement here.', identifierSeries.range);
  }

  ctx.reportError('Expected a statement here.', ctx.tokenizer.peek().range);
}

/** Parses the `(a=1, b=2)->c` of `myFn(a=1, b=2)->c`. */
function parseFunctionCall(ctx: ParseContext, fnNameSeries: IdentifierSeries): ExpressionNode {
  const fnDef = tools.lookupVarSeries(ctx, fnNameSeries);

  const start = ctx.tokenizer.peek().range.start;

  ctx.assertToken(ctx, ['(']).next();

  if (ctx.tokenizer.peek().value === ')') {
    ctx.reportError('Functions must have at least one argument', { start, end: ctx.tokenizer.peek().range.end });
  }

  const childRelationships: Relationship[] = [];
  const relationship: MutableRelationship = new Map();
  relationship.set(ctx.stdLibLinks.relationshipTypeId, fnDef.id);

  const keyScope: tools.Scope = {
    labelToDef: new Map(fnDef.varsInModule),
  };

  while (true) {
    const keyNode = parseIdentifier(ctx);
    const keyDef = tools.replaceScope(ctx, keyScope, () => {
      return tools.lookupVar(ctx, keyNode);
    });
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
  const returnParamDef = tools.replaceScope(ctx, keyScope, () => {
    return tools.lookupVar(ctx, returnParamName);
  });
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
