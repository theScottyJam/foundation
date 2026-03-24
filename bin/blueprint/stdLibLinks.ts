import type { ParseContext, Relationship } from './parserTools.ts';
import * as tools from './parserTools.ts';

export function registerStdLibLinks(ctx: Omit<ParseContext, 'stdLibLinks'>) {
  const register = (label: string, uuid: string) => {
    const varId = tools.genNextVarId(ctx);
    ctx.links.set(uuid, varId);
    ctx.varIdToLabel.set(varId, label);
    return varId;
  };

  /** All relationships should have this as a key to identify what the relationship is */
  const relationshipTypeId = register('relationshipType', '1c6c63c0-c0ae-4a64-af72-ed32de0de764');

  const varIds = {
    typeId: register('var', '2b04c7d1-41c2-4e3c-b3c9-2741b304efbf'),
    fields: {
      target: register('target', 'dffa84ea-5897-4be2-8c79-bc668e93bd23'),
    },
  };

  // <-- unused
  const typeSignatureIds = {
    typeId: register('typeSignature', 'c120e64e-ff23-4e63-9780-c426657a56a5'),
    fields: {
      target: register('target', 'bbb78612-a804-40f4-93ff-4bf9518f1d98'),
    },
  };

  return {
    relationshipTypeId,
    varIds,
    markAsVar: (targetNodeId: number): Relationship => new Map([
      [relationshipTypeId, varIds.typeId],
      [varIds.fields.target, targetNodeId],
    ]),
  };
}

export type StdLibLinks = ReturnType<typeof registerStdLibLinks>;
