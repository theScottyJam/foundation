import assert from 'node:assert/strict';
import { throwIndexOutOfBounds } from '../util.ts';

export type Relationship = Record<string, string>;

export interface BedrockData {
  readonly relationships: Relationship[]
  readonly links: Record<string, string>
}

export type NodeId = string;

/** All relationships should have this as a key to identify what the relationship is */
const RELATIONSHIP_TYPE = '1c6c63c0-c0ae-4a64-af72-ed32de0de764';

function fromUuid(data: BedrockData, uuid: string): NodeId {
  const nodeId = data.links[uuid];
  assert(nodeId !== undefined, `uuid ${uuid} is not registered`);
  return nodeId;
}

function findRelationshipsByType(data: BedrockData, typeId: NodeId): Relationship[] {
  const relationshipTypeId = fromUuid(data, RELATIONSHIP_TYPE);

  const relationships: Relationship[] = [];
  for (const relationship of data.relationships) {
    if (relationship[relationshipTypeId] === typeId) {
      relationships.push(relationship);
    }
  }

  return relationships;
}

interface ParsedRelationship<Fields extends string> {
  readonly fields: Record<Fields, NodeId>
  readonly raw: Relationship
}

interface RelationshipSchemaConstructorOpts<Fields extends string> {
  readonly data: BedrockData
  readonly typeId: NodeId
  readonly fieldNameToId: Record<Fields, NodeId>
}

export class RelationshipSchema<Fields extends string> {
  readonly #data: BedrockData;
  readonly #relationshipTypeId: NodeId;
  readonly typeId: NodeId;
  readonly fieldNameToId: Record<Fields, NodeId>;
  constructor({ data, typeId, fieldNameToId }: RelationshipSchemaConstructorOpts<Fields>) {
    this.#data = data;
    this.#relationshipTypeId = fromUuid(data, RELATIONSHIP_TYPE);
    this.typeId = typeId;
    this.fieldNameToId = fieldNameToId;
  }

  parse(relationship: Relationship): ParsedRelationship<Fields> {
    assert(relationship[this.#relationshipTypeId] === this.typeId, 'The relationship is not of the correct type.');

    const result: Partial<Record<Fields, NodeId>> = Object.create(null);
    for (const [fieldName, fieldId] of Object.entries(this.fieldNameToId) as [Fields, NodeId][]) {
      const nodeId = relationship[fieldId];
      assert(nodeId, `The relationship ${JSON.stringify(relationship)} is missing a ${fieldName} field.`);
      result[fieldName] = nodeId;
    }

    return {
      fields: result as Record<Fields, NodeId>,
      raw: relationship,
    };
  }

  #listedRelationships: ParsedRelationship<Fields>[] | undefined;
  listParsedRelationships(): ParsedRelationship<Fields>[] {
    if (this.#listedRelationships !== undefined) {
      return this.#listedRelationships;
    }

    this.#listedRelationships = findRelationshipsByType(this.#data, this.typeId)
      .map(relationship => this.parse(relationship));
    return this.#listedRelationships;
  }
}

export class BedrockNavigator {
  readonly data: BedrockData;
  readonly #entityToTypeLookup: Record<NodeId, NodeId>;
  readonly #typeToEntityLookup: Record<NodeId, NodeId[]>;
  readonly #vars: Set<NodeId>;
  readonly #inputs: Set<NodeId>;
  readonly #outputs: Set<NodeId>;
  readonly #outputVarIdToRelationship: Map<NodeId, Relationship>;
  readonly typeRelationshipSchema: RelationshipSchema<'type' | 'target'>;

  constructor(data: BedrockData) {
    this.data = data;

    const varParsedRelationships = new RelationshipSchema({
      data,
      typeId: fromUuid(data, '2b04c7d1-41c2-4e3c-b3c9-2741b304efbf'),
      fieldNameToId: {
        target: fromUuid(data, 'dffa84ea-5897-4be2-8c79-bc668e93bd23'),
      } as const,
    }).listParsedRelationships();
    this.#vars = new Set(varParsedRelationships.map(r => r.fields.target));

    // TODO: Ideally I would assert all function keys aren't variables as well.
    const assertResolved = <T extends string>(parsedRelationships: ParsedRelationship<T>[]): ParsedRelationship<T>[] => {
      for (const parsedRelationship of parsedRelationships) {
        for (const [key, value] of Object.entries<string>(parsedRelationship.fields)) {
          assert(!this.#vars.has(value), 'This cannot be set to a variable.');
        }
      }

      return parsedRelationships;
    };

    const inputParsedRelationships = assertResolved(new RelationshipSchema({
      data,
      typeId: fromUuid(data, '4fa938aa-3d98-4e79-8eac-4aad749ffaa9'),
      fieldNameToId: {
        target: fromUuid(data, '0f38cd20-0930-43d4-abcd-0ecd0b28dd69'),
      } as const,
    }).listParsedRelationships());
    this.#inputs = new Set(inputParsedRelationships.map(r => r.fields.target));

    const outputParsedRelationships = assertResolved(new RelationshipSchema({
      data,
      typeId: fromUuid(data, 'c9e807db-3c23-493a-9485-61f160557b3e'),
      fieldNameToId: {
        target: fromUuid(data, '8201a837-9620-4a70-8653-040fcacde2c8'),
      } as const,
    }).listParsedRelationships());
    this.#outputs = new Set(outputParsedRelationships.map(r => r.fields.target));

    const outputVarIdToRelationship = new Map<NodeId, Relationship>();
    this.#outputVarIdToRelationship = outputVarIdToRelationship;
    for (const relationship of data.relationships) {
      const outputKeys = Object.keys(relationship).filter(key => this.#outputs.has(key));
      assert(outputKeys.length <= 1, `Each relationship must have no more than one output. ${JSON.stringify(outputKeys)} found in ${JSON.stringify(relationship)}.`);
      const outputKey = outputKeys[0];
      if (outputKey !== undefined) {
        const value = relationship[outputKey] ?? throwIndexOutOfBounds();
        if (this.#vars.has(value)) {
          outputVarIdToRelationship.set(value, relationship);
        }
      }
    }

    this.typeRelationshipSchema = new RelationshipSchema({
      data,
      typeId: fromUuid(data, '5bc48f39-0abd-4fad-8b55-9cdc18a01ef0'),
      fieldNameToId: {
        target: fromUuid(data, '258e9ab7-b7fb-4697-891c-9962cac9ab69'),
        type: fromUuid(data, 'fe775f8a-2f8a-49e4-a079-6d9234b9354a'),
      } as const,
    });

    const entityToTypeLookup: Record<NodeId, NodeId> = Object.create(null);
    const typeToEntityLookup: Record<NodeId, NodeId[]> = Object.create(null);

    for (const parsedRelationship of assertResolved(this.typeRelationshipSchema.listParsedRelationships())) {
      entityToTypeLookup[parsedRelationship.fields.target] = parsedRelationship.fields.type;
      (typeToEntityLookup[parsedRelationship.fields.type] ??= []).push(parsedRelationship.fields.target);
    }

    this.#entityToTypeLookup = entityToTypeLookup;
    this.#typeToEntityLookup = typeToEntityLookup;
  }

  isVar(nodeId: NodeId): boolean {
    return this.#vars.has(nodeId);
  }

  isInput(nodeId: NodeId): boolean {
    return this.#inputs.has(nodeId);
  }

  isOutput(nodeId: NodeId): boolean {
    return this.#outputs.has(nodeId);
  }

  fromUuid(uuid: string): NodeId {
    return fromUuid(this.data, uuid);
  }

  getRelationshipType(relationship: Relationship): NodeId {
    const relationshipTypeId = this.fromUuid(RELATIONSHIP_TYPE);
    const type = relationship[relationshipTypeId];
    // TODO: Stop treating relationship types as just another property in a relationship, special-case it so it can never be missing.
    assert(type !== undefined, `The relationship ${JSON.stringify(relationship)} is missing a type (key: ${relationshipTypeId}).`);
    return type;
  }

  getTypeOfEntity(entityId: NodeId): NodeId {
    const typeId = this.#entityToTypeLookup[entityId];
    assert(typeId !== undefined, `${entityId} does not have a type.`);
    return typeId;
  }

  findEntitiesByType(typeId: NodeId): NodeId[] {
    return this.#typeToEntityLookup[typeId] ?? [];
  }

  relationshipFromOutputVarId(outputVarId: NodeId): Relationship {
    const relationship = this.#outputVarIdToRelationship.get(outputVarId);
    assert(relationship !== undefined, `${outputVarId} it not an output var ID for any relationships.`);
    return relationship;
  }

  isFullyResolved <T extends string>(parsedRelationship: ParsedRelationship<T>) {
    return Object.values<string>(parsedRelationship.fields).every(value => !this.#vars.has(value));
  };

  // Maps `relationship ID` to a `entity ID -> property value` mapping
  #propertyCache: Record<NodeId, Record<NodeId, NodeId>> = Object.create(null);
  /**
   * Shorthand to get the property value from relationships that are meant to act like properties.
   * Only returns the property if the relationship is fully resolved (it was defined without variables).
   */
  tryGetKnownProperty<T extends string>(entityId: NodeId, propName: T, relationshipSchema: RelationshipSchema<'target' | T>): NodeId | undefined {
    {
      const cacheForRelationship = this.#propertyCache[relationshipSchema.typeId];
      if (cacheForRelationship !== undefined) {
        return cacheForRelationship[entityId];
      }
    }

    const cacheForRelationship: Record<NodeId, NodeId> = Object.create(null);
    for (const relationship of relationshipSchema.listParsedRelationships()) {
      if (this.isFullyResolved(relationship)) {
        cacheForRelationship[relationship.fields.target] = relationship.fields[propName];
      }
    }

    this.#propertyCache[relationshipSchema.typeId] = cacheForRelationship;
    return cacheForRelationship[entityId];
  }

  // <--
  // #markedAsCompiled = new Set<string>();
  // /**
  //  * Any relationship with a relationship-id can be marked as "compiled" by this function
  //  * when it's getting used in the compiled output. Later, we can check to see if
  //  * there are any relationships that got missed - if so, that will be an error,
  //  * because those relationships may contain rules that contradict the rules that were just compiled - we
  //  * don't know for sure, so excess rules are forbidden.
  //  */
  // markAsCompiled(relationship: Relationship) {
  //   const relationshipIdKey = lookupId(this.data, RELATIONSHIP_ID);
  //   const relationshipId = relationship[relationshipIdKey];
  //   assert(
  //     relationshipId !== undefined,
  //     'Attempted to mark a relationship as compiled, but it did not have a relationship ID - only those with relationship IDs need to be marked. Relationship: ' + JSON.stringify(relationship),
  //   );

  //   this.#markedAsCompiled.add(relationshipId);
  // }

  // /** Should be called after compilation is done to make sure everything got compiled that should have. */
  // assertAllMarkedAsCompiled() {
  //   const relationshipIdKey = lookupId(this.data, RELATIONSHIP_ID);
  //   for (const relationship of this.data.relationships) {
  //     const relationshipId = relationship[relationshipIdKey];
  //     // We're not going to worry about anything that isn't conditionally compiled (i.e. things that aren't registered as rules). Those don't
  //     // tend to cause as much trouble.
  //     if (relationshipId !== undefined && !this.isMarkedAsTrue(relationshipId)) {
  //       assert(this.#markedAsCompiled.has(relationshipId), `The relationship ${JSON.stringify(relationship)} did not get used during compilation.`);
  //     }
  //   }
  // }
}
