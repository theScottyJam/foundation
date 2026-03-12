import assert from 'node:assert/strict';
import { BedrockNavigator, RelationshipSchema, type NodeId, type BedrockData } from '../bedrockNavigator/index.ts';

class NumberEntity {
  static #typeUuid = '0f7b46ea-451d-40f2-9a34-3a4530667814';

  readonly previous: NodeId | undefined;
  readonly id: string;

  constructor(nav: BedrockNavigator, entityId: NodeId) {
    assert(nav.getTypeOfEntity(entityId) === nav.lookupId(NumberEntity.#typeUuid));
    this.id = entityId;

    this.previous = nav.tryGetProperty(entityId, 'previous', new RelationshipSchema({
      data: nav.data,
      typeId: nav.lookupId('10037d13-bbd0-4f60-8e47-7b1635e620f4'),
      fieldNameToId: {
        target: nav.lookupId('7edaef67-1e08-4472-95a9-89a212e6504c'),
        previous: nav.lookupId('1a3fbabd-02e6-427b-9f46-2c20b16d71e4'),
      } as const,
    }));
  }

  static listEntities(nav: BedrockNavigator) {
    return nav.findEntitiesByType(nav.lookupId(NumberEntity.#typeUuid))
      .map(entityId => new NumberEntity(nav, entityId));
  }
}

class NumberLookup {
  readonly entityIdToValue: Record<NodeId, number>;
  constructor(nav: BedrockNavigator) {
    const entityIdToValue: Record<NodeId, number> = Object.create(null);
    for (const entity of NumberEntity.listEntities(nav)) {
      let count = -1;
      let currentEntity: NumberEntity | undefined = entity;
      while (currentEntity !== undefined) {
        count++;
        currentEntity = currentEntity.previous === undefined
          ? undefined
          : new NumberEntity(nav, currentEntity.previous);
      }

      entityIdToValue[entity.id] = count;
    }

    this.entityIdToValue = entityIdToValue;
  }
}

export function main(bedrockData: BedrockData) {
  const nav = new BedrockNavigator(bedrockData);

  const numberLookup = new NumberLookup(nav);

  const outputRelationshipSchema = new RelationshipSchema({
    data: bedrockData,
    typeId: nav.lookupId('86b33c24-e4c1-4790-a4d9-1c8af3030b34'),
    fieldNameToId: {
      value: nav.lookupId('381dde34-25e1-4c1b-a3f3-762d9ada9f9c'),
    } as const,
  });

  const parsedOutputRelationships = outputRelationshipSchema.listRelationships();
  assert(parsedOutputRelationships.length === 1, 'There should be exactly one output');
  const outputEntityId = parsedOutputRelationships[0]!.fields.value;

  const number = numberLookup.entityIdToValue[outputEntityId];
  assert(number !== undefined, 'You must output a number');
  console.log('OUTPUT:', number);
}
