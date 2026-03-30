import type { ParseContext, Relationship } from './parserTools.ts';
import * as tools from './parserTools.ts';
import type { Range } from '../types.ts';

export function getStdLibLinks() {
  const varUuids = {
    typeId: '2b04c7d1-41c2-4e3c-b3c9-2741b304efbf',
    fields: {
      target: 'dffa84ea-5897-4be2-8c79-bc668e93bd23',
    },
  };

  return {
    varUuids,
    markAsVar: (ctx: ParseContext, targetNodeId: number, range: Range): Relationship => {
      const typeId = ctx.links.get(varUuids.typeId);
      const target = ctx.links.get(varUuids.fields.target);
      if (typeId === undefined || target === undefined) {
        tools.reportError(ctx, 'Cannot use syntax to mark something as a variable until the mark-as-var UUIDs are registered.', range);
      }

      return {
        type: typeId,
        mapping: new Map([
          [target, targetNodeId],
        ]),
        range,
      };
    },
  };
}

export type StdLibLinks = ReturnType<typeof getStdLibLinks>;
