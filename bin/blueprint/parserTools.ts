import { throwIndexOutOfBounds } from '../util.ts';
import type { Range } from './shared.ts';
import type { StdLibLinks } from './stdLibLinks.ts';
import type { Tokenizer } from './Tokenizer.ts';

export type Relationship = ReadonlyMap<number, number>;
export type MutableRelationship = Map<number, number>;

export interface VarDef {
  readonly id: number
  readonly label?: string
  // Maps labels to definitions. May be mutated.
  readonly varsInScope: Map<string, VarDef>
}

export interface Scope {
  // May be mutated.
  readonly labelToDef: Map<string, VarDef>
}

export interface IdentifierNode {
  readonly identifier: string
  readonly range: Range
}

export interface ParseContext {
  readonly tokenizer: Tokenizer
  readonly reportError: (message: string, range: Range) => never
  readonly assertToken: (ctx: ParseContext, tokens: string[]) => { next: () => void }
  readonly varIdToLabel: Map<number, string>
  readonly stdLibLinks: StdLibLinks
  /** May be mutated during parsing */
  readonly links: Map<number, string>
  /** May be mutated during parsing */
  readonly scopes: Scope[]
  /** May be mutated during parsing */
  nextId: number
}

export function enterScope<T>(ctx: ParseContext, scope: Scope, callback: () => T): T {
  ctx.scopes.push(scope);
  const result = callback();
  ctx.scopes.pop();
  return result;
}

export function lookupVar(ctx: ParseContext, identifierNode: IdentifierNode): VarDef {
  for (let i = ctx.scopes.length - 1; i >= 0; i--) {
    const scope = ctx.scopes[i] ?? throwIndexOutOfBounds();
    const varDef = scope.labelToDef.get(identifierNode.identifier);
    if (varDef !== undefined) {
      return varDef;
    }
  }

  ctx.reportError(`The identifier ${identifierNode.identifier} was not in scope.`, identifierNode.range);
}

export function genNextVarId(ctx: Omit<ParseContext, 'stdLibLinks'>) {
  return ctx.nextId++;
}
