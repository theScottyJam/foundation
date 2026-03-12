import assert from 'node:assert/strict';

type Relationship = Record<string, string>;

export interface BedrockData {
  readonly relationships: Relationship[]
  readonly links: Record<string, string>
}

export type NodeId = string;

/** All relationships should have this as a key to identify what the relationship is */
const RELATIONSHIP_TYPE = '1c6c63c0-c0ae-4a64-af72-ed32de0de764';

interface ParsedRelationship<Fields extends string> {
  readonly fields: Record<Fields, NodeId>
  readonly raw: Relationship
}

interface RelationshipSchemaConstructorOpts<Fields extends string> {
  readonly data: BedrockData
  readonly typeId: NodeId
  readonly fieldNameToId: Record<Fields, NodeId>
}

function lookupId(data: BedrockData, uuid: string): NodeId {
  const nodeId = data.links[uuid];
  assert(nodeId !== undefined, `uuid ${uuid} is not registered`);
  return nodeId;
}

function findRelationshipsByType(data: BedrockData, typeId: NodeId): Relationship[] {
  const relationshipTypeId = lookupId(data, RELATIONSHIP_TYPE);

  const relationships: Relationship[] = [];
  for (const relationship of data.relationships) {
    if (relationship[relationshipTypeId] === typeId) {
      relationships.push(relationship);
    }
  }

  return relationships;
}

export class RelationshipSchema<Fields extends string> {
  readonly #data: BedrockData;
  readonly #relationshipTypeId: NodeId;
  readonly typeId: NodeId;
  readonly fieldNameToId: Record<Fields, NodeId>;
  constructor({ data, typeId, fieldNameToId }: RelationshipSchemaConstructorOpts<Fields>) {
    this.#data = data;
    this.#relationshipTypeId = lookupId(data, RELATIONSHIP_TYPE);
    this.typeId = typeId;
    this.fieldNameToId = fieldNameToId;
  }

  parse(relationship: Relationship): ParsedRelationship<Fields> {
    assert(relationship[this.#relationshipTypeId] === this.typeId, 'The relationship is not of the correct type.');

    const result: Partial<Record<Fields, NodeId>> = Object.create(null);
    for (const [fieldName, fieldId] of Object.entries(this.fieldNameToId) as [Fields, NodeId][]) {
      const nodeId = relationship[fieldId];
      assert(nodeId, `A relationship is missing a ${fieldName} field.`);
      result[fieldName] = nodeId;
    }

    return {
      fields: result as Record<Fields, NodeId>,
      raw: relationship,
    };
  }

  /** List relationships of this type */
  #listedRelationships: ParsedRelationship<Fields>[] | undefined;
  listRelationships() {
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

  constructor(data: BedrockData) {
    this.data = data;
    const typeRelationshipSchema = new RelationshipSchema({
      data,
      typeId: lookupId(data, '5bc48f39-0abd-4fad-8b55-9cdc18a01ef0'),
      fieldNameToId: {
        target: lookupId(data, '258e9ab7-b7fb-4697-891c-9962cac9ab69'),
        type: lookupId(data, 'fe775f8a-2f8a-49e4-a079-6d9234b9354a'),
      } as const,
    });

    const entityToTypeLookup: Record<NodeId, NodeId> = Object.create(null);
    const typeToEntityLookup: Record<NodeId, NodeId[]> = Object.create(null);

    for (const parsedRelationship of typeRelationshipSchema.listRelationships()) {
      entityToTypeLookup[parsedRelationship.fields.target] = parsedRelationship.fields.type;
      (typeToEntityLookup[parsedRelationship.fields.type] ??= []).push(parsedRelationship.fields.target);
    }

    this.#entityToTypeLookup = entityToTypeLookup;
    this.#typeToEntityLookup = typeToEntityLookup;
  }

  lookupId(uuid: string): NodeId {
    return lookupId(this.data, uuid);
  }

  getTypeOfEntity(entityId: NodeId): NodeId {
    const typeId = this.#entityToTypeLookup[entityId];
    assert(typeId !== undefined, `${entityId} does not have a type.`);
    return typeId;
  }

  findEntitiesByType(typeId: NodeId): NodeId[] {
    return this.#typeToEntityLookup[typeId] ?? [];
  }

  // Maps `relationship ID` to a `entity ID -> property value` mapping
  #propertyCache: Record<NodeId, Record<NodeId, NodeId>> = Object.create(null);
  /** Shorthand to get the property value from relationships that are meant to act like properties. */
  tryGetProperty<T extends string>(entityId: NodeId, propName: T, relationshipSchema: RelationshipSchema<'target' | T>): NodeId | undefined {
    {
      const cacheForRelationship = this.#propertyCache[relationshipSchema.typeId];
      if (cacheForRelationship !== undefined) {
        return cacheForRelationship[entityId];
      }
    }

    const cacheForRelationship = Object.create(null);
    for (const relationship of relationshipSchema.listRelationships()) {
      cacheForRelationship[relationship.fields.target] = relationship.fields[propName];
    }

    this.#propertyCache[relationshipSchema.typeId] = cacheForRelationship;
    return cacheForRelationship[entityId];
  }
}
