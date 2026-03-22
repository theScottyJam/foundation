import type { ParseContext, Relationship } from './parserTools.ts';
import * as tools from './parserTools.ts';

export function registerStdLibLinks(ctx: Omit<ParseContext, 'stdLibLinks'>) {
  const register = (label: string, uuid: string) => {
    const varId = tools.genNextVarId(ctx);
    ctx.links.set(varId, uuid);
    ctx.varIdToLabel.set(varId, label);
    return varId;
  };

  /** All relationships should have this as a key to identify what the relationship is */
  const relationshipTypeId = register('relationshipType', '1c6c63c0-c0ae-4a64-af72-ed32de0de764');

  const isTrueIds = {
    relationshipType: register('isTrue', 'ce8c135e-f264-427d-86cf-e1b08e6bfeb8'),
    target: register('target', '28c5a667-97c5-4226-ac3b-86c98409c550'),
  };

  // -- Not yet used --
  // const varIds = {
  //   relationshipType: register('var', '2b04c7d1-41c2-4e3c-b3c9-2741b304efbf'),
  //   target: register('target', 'dffa84ea-5897-4be2-8c79-bc668e93bd23'),
  // };

  // const entityTypeIds = {
  //   relationshipType: register('entityType', '5bc48f39-0abd-4fad-8b55-9cdc18a01ef0'),
  //   target: register('target', '258e9ab7-b7fb-4697-891c-9962cac9ab69'),
  //   type: register('type', 'fe775f8a-2f8a-49e4-a079-6d9234b9354a'),
  // };

  return {
    relationshipTypeId,
    isTrueIds,
    // varIds,
    // entityTypeIds,
    createRule(target: number): Relationship {
      return new Map([
        [relationshipTypeId, isTrueIds.relationshipType],
        [isTrueIds.target, target],
      ]);
    },
  };
}

export type StdLibLinks = ReturnType<typeof registerStdLibLinks>;
