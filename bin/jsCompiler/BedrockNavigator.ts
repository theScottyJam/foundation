import assert from 'node:assert/strict';
import { throwIndexOutOfBounds } from '../util.ts';
import type { BedrockData, Range, RelationshipData } from '../types.ts';
import { buildErrorWithUnderlinedText } from '../errorFormatter.ts';

export type NodeId = string;

function reprRelationship(relationship: RelationshipData) {
  return (
    relationship.type +
    '(' +
    Object.entries(relationship.mapping).map(([key, value]) => `${key}=${value}`).join(', ') +
    ')'
  );
}

function reportError(data: BedrockData, message: string, relationship: RelationshipData): never {
  throw new Error(buildErrorWithUnderlinedText(message + `\nRelationship: ${reprRelationship(relationship)}`, {
    fileContents: data.sourceText,
    start: relationship.range.start.index,
    end: relationship.range.end.index,
  }));
}

function fromUuid(data: BedrockData, uuid: string): NodeId {
  const nodeId = data.links[uuid];
  assert(nodeId !== undefined, `uuid ${uuid} is not registered`);
  return nodeId;
}

function findRelationshipsByType(data: BedrockData, typeId: NodeId): RelationshipData[] {
  const relationships: RelationshipData[] = [];
  for (const relationship of data.relationships) {
    if (relationship.type === typeId) {
      relationships.push(relationship);
    }
  }

  return relationships;
}

export interface ParsedRelationship<Fields extends string> {
  readonly fields: Record<Fields, NodeId>
  readonly raw: RelationshipData
}

interface RelationshipSchemaConstructorOpts<Fields extends string> {
  readonly typeId: NodeId
  readonly fieldNameToId: Record<Fields, NodeId>
}

export class RelationshipSchema<Fields extends string> {
  readonly typeId: NodeId;
  readonly fieldNameToId: Record<Fields, NodeId>;
  constructor({ typeId, fieldNameToId }: RelationshipSchemaConstructorOpts<Fields>) {
    this.typeId = typeId;
    this.fieldNameToId = fieldNameToId;
  }

  parse(data: BedrockData, relationship: RelationshipData): ParsedRelationship<Fields> {
    if (relationship.type !== this.typeId) {
      reportError(data, 'The relationship is not of the correct type.', relationship);
    }

    const result: Partial<Record<Fields, NodeId>> = Object.create(null);
    for (const [fieldName, fieldId] of Object.entries(this.fieldNameToId) as [Fields, NodeId][]) {
      const nodeId = relationship.mapping[fieldId];
      if (nodeId === undefined) {
        reportError(data, `This relationship is missing a "${fieldName}" field.`, relationship);
      }
      result[fieldName] = nodeId;
    }

    return {
      fields: result as Record<Fields, NodeId>,
      raw: relationship,
    };
  }

  #listedRelationships: ParsedRelationship<Fields>[] | undefined;
  listParsedRelationships(data: BedrockData): ParsedRelationship<Fields>[] {
    if (this.#listedRelationships !== undefined) {
      return this.#listedRelationships;
    }

    this.#listedRelationships = findRelationshipsByType(data, this.typeId)
      .map(relationship => this.parse(data, relationship));
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
  readonly #outputVarIdToNonSignatureRelationships: Map<NodeId, RelationshipData[]>;
  readonly #relationshipIdToRelationship: Map<NodeId, RelationshipData>;
  readonly #fnIdToSignatures: Map<NodeId, NodeId[]>;
  readonly typeRelationshipSchema: RelationshipSchema<'type' | 'target'>;

  constructor(data: BedrockData) {
    this.data = data;

    const varParsedRelationships = new RelationshipSchema({
      typeId: fromUuid(data, '2b04c7d1-41c2-4e3c-b3c9-2741b304efbf'),
      fieldNameToId: {
        target: fromUuid(data, 'dffa84ea-5897-4be2-8c79-bc668e93bd23'),
      } as const,
    }).listParsedRelationships(data);
    this.#vars = new Set(varParsedRelationships.map(r => r.fields.target));

    // TODO: Ideally I would assert all function keys aren't variables as well.
    const assertResolved = <T extends string>(parsedRelationships: ParsedRelationship<T>[]): ParsedRelationship<T>[] => {
      for (const parsedRelationship of parsedRelationships) {
        for (const value of Object.values<string>(parsedRelationship.fields)) {
          if (this.#vars.has(value)) {
            reportError(data, `${value} cannot be set to a variable`, parsedRelationship.raw);
          }
        }
      }

      return parsedRelationships;
    };

    const inputParsedRelationships = assertResolved(new RelationshipSchema({
      typeId: fromUuid(data, '4fa938aa-3d98-4e79-8eac-4aad749ffaa9'),
      fieldNameToId: {
        target: fromUuid(data, '0f38cd20-0930-43d4-abcd-0ecd0b28dd69'),
      } as const,
    }).listParsedRelationships(data));
    this.#inputs = new Set(inputParsedRelationships.map(r => r.fields.target));

    const outputParsedRelationships = assertResolved(new RelationshipSchema({
      typeId: fromUuid(data, 'c9e807db-3c23-493a-9485-61f160557b3e'),
      fieldNameToId: {
        target: fromUuid(data, '8201a837-9620-4a70-8653-040fcacde2c8'),
      } as const,
    }).listParsedRelationships(data));
    this.#outputs = new Set(outputParsedRelationships.map(r => r.fields.target));

    this.typeRelationshipSchema = new RelationshipSchema({
      typeId: fromUuid(data, '5bc48f39-0abd-4fad-8b55-9cdc18a01ef0'),
      fieldNameToId: {
        target: fromUuid(data, '258e9ab7-b7fb-4697-891c-9962cac9ab69'),
        type: fromUuid(data, 'fe775f8a-2f8a-49e4-a079-6d9234b9354a'),
      } as const,
    });

    const entityToTypeLookup: Record<NodeId, NodeId> = Object.create(null);
    const typeToEntityLookup: Record<NodeId, NodeId[]> = Object.create(null);

    for (const parsedRelationship of assertResolved(this.typeRelationshipSchema.listParsedRelationships(data))) {
      entityToTypeLookup[parsedRelationship.fields.target] = parsedRelationship.fields.type;
      (typeToEntityLookup[parsedRelationship.fields.type] ??= []).push(parsedRelationship.fields.target);
    }

    this.#entityToTypeLookup = entityToTypeLookup;
    this.#typeToEntityLookup = typeToEntityLookup;

    const relationshipIdToRelationship = new Map<NodeId, RelationshipData>();
    const relationshipIdKey = fromUuid(data, '6c3723e0-ca7e-4ef7-905a-b5680c5dc8a7');
    for (const relationship of this.data.relationships) {
      if (relationshipIdKey in relationship.mapping) {
        const relationshipId = relationship.mapping[relationshipIdKey] ?? throwIndexOutOfBounds();
        relationshipIdToRelationship.set(relationshipId, relationship);
      }
    }
    this.#relationshipIdToRelationship = relationshipIdToRelationship;

    const fnSignatureMarkers = assertResolved(new RelationshipSchema({
      typeId: fromUuid(data, 'b1fb74a3-e4e1-4e79-bec2-fef9e4fe5ba3'),
      fieldNameToId: {
        target: fromUuid(data, 'afad68d8-6b22-4881-9346-ab0795d367d6'),
      } as const,
    }).listParsedRelationships(data));

    const fnIdToSignatures = new Map<NodeId, NodeId[]>();
    for (const parsedRelationship of fnSignatureMarkers) {
      const relationshipId = parsedRelationship.fields.target;
      const type = relationshipIdToRelationship.get(relationshipId)?.type ?? throwIndexOutOfBounds();
      const signatures = fnIdToSignatures.get(type) ?? [];
      fnIdToSignatures.set(type, signatures);
      signatures.push(relationshipId);
    }
    this.#fnIdToSignatures = fnIdToSignatures;

    const outputVarIdToRelationship = new Map<NodeId, RelationshipData[]>();
    for (const relationship of data.relationships) {
      const outputKeys = Object.keys(relationship.mapping).filter(key => this.#outputs.has(key));
      if (outputKeys.length > 1) {
        reportError(data, `Each relationship must have no more than one output. ${JSON.stringify(outputKeys)} found.`, relationship);
      }
      const outputKey = outputKeys[0];
      if (outputKey !== undefined) {
        const value = relationship.mapping[outputKey] ?? throwIndexOutOfBounds();
        if (this.#vars.has(value)) {
          const isSignatureRelationship = (
            relationship.mapping[relationshipIdKey] !== undefined &&
            relationshipIdToRelationship.has(relationship.mapping[relationshipIdKey])
          );
          if (!isSignatureRelationship) {
            const relationships = outputVarIdToRelationship.get(value) ?? [];
            outputVarIdToRelationship.set(value, relationships);
            relationships.push(relationship);
          }
        }
      }
    }
    this.#outputVarIdToNonSignatureRelationships = outputVarIdToRelationship;
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

  lookupFnSignatureIds(fnId: NodeId): NodeId[] {
    return this.#fnIdToSignatures.get(fnId) ?? [];
  }

  lookupRelationship(relationshipId: NodeId): RelationshipData {
    return this.#relationshipIdToRelationship.get(relationshipId) ?? throwIndexOutOfBounds();
  }

  fromUuid(uuid: string): NodeId {
    return fromUuid(this.data, uuid);
  }

  tryGetTypeOfEntity(entityId: NodeId): NodeId | undefined {
    return this.#entityToTypeLookup[entityId];
  }

  getTypeOfEntity(entityId: NodeId): NodeId {
    const typeId = this.#entityToTypeLookup[entityId];
    assert(typeId !== undefined, `${entityId} does not have a type.`);
    return typeId;
  }

  findEntitiesByType(typeId: NodeId): NodeId[] {
    return this.#typeToEntityLookup[typeId] ?? [];
  }

  findRelationshipsByType = findRelationshipsByType;

  /**
   * {@link sourceRelationship} is where this outputVarId was found, so if we fail to look it up, we know what line to highlight.
   *
   * Returns all relationships (that aren't marked as a function signature) that produces the {@link outputVarId} as an output.
   */
  nonSignatureRelationshipsFromOutputVarId(outputVarId: NodeId, sourceRelationship: RelationshipData): RelationshipData[] {
    const relationships = this.#outputVarIdToNonSignatureRelationships.get(outputVarId);
    return relationships ?? [];
  }

  reportError(message: string, relationship: RelationshipData): never {
    reportError(this.data, message, relationship);
  }

  isFullyResolved <T extends string>(parsedRelationship: ParsedRelationship<T>) {
    return Object.values<string>(parsedRelationship.fields).every(value => !this.#vars.has(value));
  };

  getInputsAndOutputs(relationship: RelationshipData) {
    const inputNodeIds: NodeId[] = [];
    let outputNodeId: NodeId | undefined;
    for (const [key, value] of Object.entries(relationship.mapping)) {
      if (this.isInput(key)) {
        inputNodeIds.push(key);
      } else if (this.isOutput(key)) {
        if (outputNodeId !== undefined) {
          this.reportError(`This relationship had more than one output, including ${outputNodeId} and ${key}.`, relationship);
        }

        outputNodeId = key;
      }
    }

    if (outputNodeId === undefined) {
      this.reportError('This relationship did not have any outputs.', relationship);
    }

    return { inputNodeIds, outputNodeId };
  }

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
    for (const relationship of relationshipSchema.listParsedRelationships(this.data)) {
      if (this.isFullyResolved(relationship)) {
        cacheForRelationship[relationship.fields.target] = relationship.fields[propName];
      }
    }

    this.#propertyCache[relationshipSchema.typeId] = cacheForRelationship;
    return cacheForRelationship[entityId];
  }
}
