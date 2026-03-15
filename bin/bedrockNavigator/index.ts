import assert from 'node:assert/strict';

type Relationship = Record<string, string>;

export interface BedrockData {
  readonly relationships: Relationship[]
  readonly links: Record<string, string>
}

export type NodeId = string;

/** All relationships should have this as a key to identify what the relationship is */
const RELATIONSHIP_TYPE = '1c6c63c0-c0ae-4a64-af72-ed32de0de764';

/**
 * Most relationships (with few relationship types as exceptions) should have this as a key, which is
 * used to uniquely identify the relationship and allow relationships to be chained together.
 */
const RELATIONSHIP_ID = '4f092890-951e-4795-9700-d1afc604d337';

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

interface ParsedRelationship<Fields extends string> {
  readonly fields: Record<Fields, NodeId>
  readonly raw: Relationship
}

interface RelationshipSchemaConstructorOpts<Fields extends string> {
  readonly data: BedrockData
  /** @internal - if it has a relationship ID, use {@link ConditionalRelationshipSchema} instead. */
  readonly hasRelationshipId?: boolean
  readonly typeId: NodeId
  readonly fieldNameToId: Record<Fields, NodeId>
}

export class RelationshipSchema<Fields extends string> {
  readonly #data: BedrockData;
  readonly #relationshipTypeId: NodeId;
  readonly #hasRelationshipId: boolean;
  readonly typeId: NodeId;
  readonly fieldNameToId: Record<Fields, NodeId>;
  constructor({ data, hasRelationshipId, typeId, fieldNameToId }: RelationshipSchemaConstructorOpts<Fields>) {
    this.#data = data;
    this.#relationshipTypeId = lookupId(data, RELATIONSHIP_TYPE);
    this.#hasRelationshipId = hasRelationshipId ?? false;
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

    if (!this.#hasRelationshipId) {
      const relationshipId = lookupId(this.#data, RELATIONSHIP_ID);
      assert(relationship[relationshipId] === undefined, `This relationship had a relationship ID when it was not expected to have one: ${JSON.stringify(relationship)}`);
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

interface NavForConditionalRelationshipSchema {
  readonly data: BedrockData
  readonly isRule: (nodeId: NodeId) => boolean
  readonly isVar: (nodeId: NodeId) => boolean
  readonly isRelationshipId: (nodeId: NodeId) => boolean
}

function identifyConditionalValue(nav: NavForConditionalRelationshipSchema, value: NodeId): ConditionalFieldValue {
  if (nav.isVar(value)) {
    return { type: 'var' as const, value };
  } else if (nav.isRelationshipId(value)) {
    return { type: 'expression' as const, value };
  } else {
    return { type: 'value' as const, value };
  }
}

export type ConditionalFieldValue = { type: 'value', value: NodeId } | { type: 'var', value: NodeId } | { type: 'expression', value: NodeId };

interface ConditionallyParsedRelationship<Fields extends string> {
  readonly relationshipId: NodeId
  readonly fields: Record<Fields, ConditionalFieldValue>
  readonly raw: Relationship
}

interface ConditionalRelationshipSchemaConstructorOpts<Fields extends string> {
  readonly nav: NavForConditionalRelationshipSchema
  readonly typeId: NodeId
  readonly fieldNameToId: Record<Fields, NodeId>
}

export class ConditionalRelationshipSchema<Fields extends string> {
  readonly #nav: NavForConditionalRelationshipSchema;
  readonly #schema: RelationshipSchema<Fields | 'relationshipId'>;
  readonly typeId: NodeId;
  readonly fieldNameToId: Record<Fields, NodeId>;

  constructor(opts: ConditionalRelationshipSchemaConstructorOpts<Fields>) {
    this.#nav = opts.nav;
    this.#schema = new RelationshipSchema({
      data: opts.nav.data,
      hasRelationshipId: true,
      typeId: opts.typeId,
      fieldNameToId: {
        ...opts.fieldNameToId,
        relationshipId: lookupId(opts.nav.data, RELATIONSHIP_ID),
      },
    });

    this.typeId = this.#schema.typeId;
    this.fieldNameToId = this.#schema.fieldNameToId;
  }

  /**
   * List relationships of this type.
   * A relationship will only be included in this list if
   * that relationship ID is registered as a rule (i.e. it's obvious the relationship isn't conditionally applied).
   */
  listTrueParsedRelationships(): ConditionallyParsedRelationship<Fields>[] {
    return this.#schema.listParsedRelationships()
      .filter(parsedRelationship => {
        assert(this.#nav.isRule !== undefined);
        return this.#nav.isRule(parsedRelationship.fields.relationshipId);
      })
      .map(parsedRelationship => {
        const { relationshipId, ...remainingFields } = parsedRelationship.fields;
        return {
          relationshipId,
          fields: Object.fromEntries(
            Object.entries<NodeId>(remainingFields).map(([key, value]) => {
              return [key, identifyConditionalValue(this.#nav, value)];
            }),
          ) as Record<Fields, ConditionalFieldValue>,
          raw: parsedRelationship.raw,
        } satisfies ConditionallyParsedRelationship<Fields>;
      });
  }

  static assertAllValues<Fields extends string>(
    parsedRelationship: ConditionallyParsedRelationship<Fields>,
  ): ConditionallyParsedRelationship<Fields> & { fields: Record<string, { type: 'value' }> } {
    for (const [key, maybeValue] of Object.entries<ConditionalFieldValue>(parsedRelationship.fields)) {
      assert(maybeValue.type === 'value', `Expected the value to not be based on a condition. Key "${key}" in ${JSON.stringify(parsedRelationship)}`);
    }

    return parsedRelationship as any;
  }
}

export class BedrockNavigator {
  readonly data: BedrockData;
  readonly #entityToTypeLookup: Record<NodeId, NodeId>;
  readonly #typeToEntityLookup: Record<NodeId, NodeId[]>;
  readonly #rules: Set<NodeId>;
  readonly #vars: Set<NodeId>;
  readonly #relationshipIdsToRelationships: Map<NodeId, Relationship>;
  /** A unique id for a relationship that can be used to join relationships together with boolean logic. */
  readonly relationshipIdKey: NodeId;
  readonly isRule: (nodeId: NodeId) => boolean;
  readonly isVar: (nodeId: NodeId) => boolean;
  readonly isRelationshipId: (nodeId: NodeId) => boolean;
  readonly typeRelationshipSchema: ConditionalRelationshipSchema<'type' | 'target'>;

  constructor(data: BedrockData) {
    this.data = data;

    const ruleParsedRelationships = new RelationshipSchema({
      data,
      typeId: lookupId(data, 'ce8c135e-f264-427d-86cf-e1b08e6bfeb8'),
      fieldNameToId: {
        target: lookupId(data, '28c5a667-97c5-4226-ac3b-86c98409c550'),
      } as const,
    }).listParsedRelationships();
    this.#rules = new Set(ruleParsedRelationships.map(r => r.fields.target));
    const isRule = (nodeId: NodeId) => this.#rules.has(nodeId);
    this.isRule = isRule;

    const varParsedRelationships = new RelationshipSchema({
      data,
      typeId: lookupId(data, '2b04c7d1-41c2-4e3c-b3c9-2741b304efbf'),
      fieldNameToId: {
        target: lookupId(data, 'dffa84ea-5897-4be2-8c79-bc668e93bd23'),
      } as const,
    }).listParsedRelationships();
    this.#vars = new Set(varParsedRelationships.map(r => r.fields.target));
    const isVar = (nodeId: NodeId) => this.#vars.has(nodeId);
    this.isVar = isVar;

    const relationshipIdsToRelationships = new Map<NodeId, Relationship>();
    this.#relationshipIdsToRelationships = relationshipIdsToRelationships;
    this.relationshipIdKey = lookupId(data, RELATIONSHIP_ID);
    for (const relationship of data.relationships) {
      const maybeRelationshipId = relationship[this.relationshipIdKey];
      if (maybeRelationshipId !== undefined) {
        relationshipIdsToRelationships.set(maybeRelationshipId, relationship);
      }
    }
    const isRelationshipId = (nodeId: NodeId) => this.#relationshipIdsToRelationships.has(nodeId);
    this.isRelationshipId = isRelationshipId;

    this.typeRelationshipSchema = new ConditionalRelationshipSchema({
      nav: { data, isRule, isVar, isRelationshipId },
      typeId: lookupId(data, '5bc48f39-0abd-4fad-8b55-9cdc18a01ef0'),
      fieldNameToId: {
        target: lookupId(data, '258e9ab7-b7fb-4697-891c-9962cac9ab69'),
        type: lookupId(data, 'fe775f8a-2f8a-49e4-a079-6d9234b9354a'),
      } as const,
    });

    const entityToTypeLookup: Record<NodeId, NodeId> = Object.create(null);
    const typeToEntityLookup: Record<NodeId, NodeId[]> = Object.create(null);

    for (const parsedRelationship_ of this.typeRelationshipSchema.listTrueParsedRelationships()) {
      const parsedRelationship = ConditionalRelationshipSchema.assertAllValues(parsedRelationship_);
      entityToTypeLookup[parsedRelationship.fields.target.value] = parsedRelationship.fields.type.value;
      (typeToEntityLookup[parsedRelationship.fields.type.value] ??= []).push(parsedRelationship.fields.target.value);
    }

    this.#entityToTypeLookup = entityToTypeLookup;
    this.#typeToEntityLookup = typeToEntityLookup;
  }

  lookupRelationship(relationshipId: NodeId): Relationship {
    const relationship = this.#relationshipIdsToRelationships.get(relationshipId);
    assert(relationship !== undefined, `The relationship with id "${relationshipId}" does not exist`);
    return relationship;
  }

  lookupId(uuid: string): NodeId {
    return lookupId(this.data, uuid);
  }

  identifyConditionalValue(nodeId: NodeId) {
    return identifyConditionalValue(this, nodeId);
  }

  getRelationshipType(relationship: Relationship): NodeId {
    const relationshipTypeId = this.lookupId(RELATIONSHIP_TYPE);
    const type = relationship[relationshipTypeId];
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

  // Maps `relationship ID` to a `entity ID -> property value` mapping
  #propertyCache: Record<NodeId, Record<NodeId, NodeId>> = Object.create(null);
  /**
   * Shorthand to get the property value from relationships that are meant to act like properties.
   * Only returns the property if the relationship is registered as a rule (i.e. it's obvious the relationship isn't conditionally applied).
   */
  tryGetTrueProperty<T extends string>(entityId: NodeId, propName: T, relationshipSchema: ConditionalRelationshipSchema<'target' | T>): NodeId | undefined {
    {
      const cacheForRelationship = this.#propertyCache[relationshipSchema.typeId];
      if (cacheForRelationship !== undefined) {
        return cacheForRelationship[entityId];
      }
    }

    const cacheForRelationship: Record<NodeId, NodeId> = Object.create(null);
    for (const relationship_ of relationshipSchema.listTrueParsedRelationships()) {
      const relationship = ConditionalRelationshipSchema.assertAllValues(relationship_);
      cacheForRelationship[relationship.fields.target.value] = relationship.fields[propName].value;
    }

    this.#propertyCache[relationshipSchema.typeId] = cacheForRelationship;
    return cacheForRelationship[entityId];
  }

  #markedAsCompiled = new Set<string>();
  /**
   * Any relationship with a relationship-id can be marked as "compiled" by this function
   * when it's getting used in the compiled output. Later, we can check to see if
   * there are any relationships that got missed - if so, that will be an error,
   * because those relationships may contain rules that contradict the rules that were just compiled - we
   * don't know for sure, so excess rules are forbidden.
   */
  markAsCompiled(relationship: Relationship) {
    const relationshipIdKey = lookupId(this.data, RELATIONSHIP_ID);
    const relationshipId = relationship[relationshipIdKey];
    assert(
      relationshipId !== undefined,
      'Attempted to mark a relationship as compiled, but it did not have a relationship ID - only those with relationship IDs need to be marked. Relationship: ' + JSON.stringify(relationship),
    );

    this.#markedAsCompiled.add(relationshipId);
  }

  /** Should be called after compilation is done to make sure everything got compiled that should have. */
  assertAllMarkedAsCompiled() {
    const relationshipIdKey = lookupId(this.data, RELATIONSHIP_ID);
    for (const relationship of this.data.relationships) {
      const relationshipId = relationship[relationshipIdKey];
      // We're not going to worry about anything that isn't conditionally compiled (i.e. things that aren't registered as rules). Those don't
      // tend to cause as much trouble.
      if (relationshipId !== undefined && !this.isRule(relationshipId)) {
        assert(this.#markedAsCompiled.has(relationshipId), `The relationship ${JSON.stringify(relationship)} did not get used during compilation.`);
      }
    }
  }
}
