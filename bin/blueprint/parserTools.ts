import { throwIndexOutOfBounds } from '../util.ts';
import { buildErrorWithUnderlinedText } from '../errorFormatter.ts';
import type { Range } from '../types.ts';
import type { StdLibLinks } from './stdLibLinks.ts';
import type { Tokenizer } from './Tokenizer.ts';

export interface Relationship {
  readonly type: number
  readonly mapping: ReadonlyMap<number, number>
  readonly range: Range
}

export interface MutableRelationship {
  type: number
  mapping: Map<number, number>
  range?: Range
}

export interface VarDef {
  readonly id: number
  readonly label?: string
  // Maps labels to definitions. May be mutated.
  readonly varsInModule: Map<string, VarDef>
}

export interface Scope {
  // May be mutated.
  readonly labelToDef: Map<string, VarDef>
}

export interface IdentifierNode {
  readonly identifier: string
  readonly range: Range
}

export interface IdentifierSeries {
  readonly series: IdentifierNode[]
  readonly range: Range
}

export interface ParseContext {
  readonly tokenizer: Tokenizer
  readonly varIdToLabel: Map<number, string>
  readonly stdLibLinks: StdLibLinks
  /** May be mutated during parsing */
  readonly links: Map<string, number>
  readonly globalScope: Scope
  /** May be mutated during parsing */
  scopes: Scope[]
  /** May be mutated during parsing */
  nextId: number
}

export function reportError(ctx: ParseContext, message: string, range: Range): never {
  throw new Error(buildErrorWithUnderlinedText(message, {
    fileContents: ctx.tokenizer.text,
    start: range.start.index,
    end: range.end.index,
  }));
}

export function assertToken(ctx: ParseContext, tokenValues: string[]) {
  if (!tokenValues.includes(ctx.tokenizer.peek().value)) {
    reportError(ctx, `Expected "${ctx.tokenizer.peek().value}" to be one of ${tokenValues.map(t => `"${t}"`).join(', ')}.`, {
      start: ctx.tokenizer.peek().range.start,
      end: ctx.tokenizer.peek().range.end,
    });
  }

  // Returns a commonly-used follow-on action, to allow it to be easily chained if wanted.
  return {
    next: () => ctx.tokenizer.next(),
  };
}

export function enterScope<T>(ctx: ParseContext, scope: Scope, callback: () => T): T {
  ctx.scopes.push(scope);
  try {
    return callback();
  } finally {
    ctx.scopes.pop();
  }
}

export function replaceScope<T>(ctx: ParseContext, scope: Scope, callback: () => T): T {
  const oldScopes = ctx.scopes;
  ctx.scopes = [scope];
  const result = callback();
  ctx.scopes = oldScopes;
  return result;
}

export function lookupVarSeries(ctx: ParseContext, series: IdentifierSeries): VarDef {
  const [first = throwIndexOutOfBounds(), ...remaining] = series.series;

  let varDef: VarDef | { varsInModule: Map<string, VarDef>, isGlobalScope: true };
  if (first.identifier === 'global') {
    varDef = { varsInModule: ctx.globalScope.labelToDef, isGlobalScope: true };
  } else {
    const varDef_ = tryLookupVar(ctx, first.identifier);

    if (varDef_ === undefined) {
      reportError(ctx, `The identifier ${first.identifier} was not in scope.`, first.range);
    }
    varDef = varDef_;
  }

  for (const identifierNode of remaining) {
    const varDef_ = varDef.varsInModule.get(identifierNode.identifier);
    if (varDef_ === undefined) {
      reportError(ctx, `"${identifierNode.identifier}" does not exist.`, identifierNode.range);
    }
    varDef = varDef_;
  }

  if ('isGlobalScope' in varDef) {
    reportError(ctx, '"global" must be followed by ":XXX".', series.range);
  }
  return varDef;
}

/** Generally shouldn't be used - prefer looking up var-series instead. */
export function tryLookupVar(ctx: ParseContext, identifier: string): VarDef | undefined {
  for (let i = ctx.scopes.length - 1; i >= 0; i--) {
    const scope = ctx.scopes[i] ?? throwIndexOutOfBounds();
    const varDef = scope.labelToDef.get(identifier);
    if (varDef !== undefined) {
      return varDef;
    }
  }

  return undefined;
}

export function genNextVarId(ctx: ParseContext) {
  return ctx.nextId++;
}
