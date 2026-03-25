import type { ParseContext, Relationship } from './parserTools.ts';
import * as tools from './parserTools.ts';
import type { Range } from './shared.ts';

export function registerStdLibLinks(ctx: Omit<ParseContext, 'stdLibLinks'>) {
  const register = (label: string, uuid: string) => {
    const varId = tools.genNextVarId(ctx);
    ctx.links.set(uuid, varId);
    ctx.varIdToLabel.set(varId, label);
    return varId;
  };

  /** All relationships should have this as a key to identify what the relationship is */
  const relationshipTypeId = register('relationshipType', '1c6c63c0-c0ae-4a64-af72-ed32de0de764');

  const varUuids = {
    typeId: '2b04c7d1-41c2-4e3c-b3c9-2741b304efbf',
    fields: {
      target: 'dffa84ea-5897-4be2-8c79-bc668e93bd23',
    },
  };

  return {
    relationshipTypeId,
    varUuids,
    markAsVar: (ctx: ParseContext, targetNodeId: number, range: Range): Relationship => {
      const typeId = ctx.links.get(varUuids.typeId);
      const target = ctx.links.get(varUuids.fields.target);
      if (typeId === undefined || target === undefined) {
        tools.reportError(ctx, 'Cannot use syntax to mark something as a variable until the mark-as-var UUIDs are registered.', range);
      }
      return new Map([
        [relationshipTypeId, typeId],
        [target, targetNodeId],
      ]);
    },
  };
}

export type StdLibLinks = ReturnType<typeof registerStdLibLinks>;
