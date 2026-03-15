import assert from 'node:assert/strict';
import {
  BedrockNavigator,
  RelationshipSchema,
  ConditionalRelationshipSchema,
  type NodeId,
  type BedrockData,
  type ConditionalFieldValue,
} from '../bedrockNavigator/index.ts';
import { UnreachableCaseError } from '../util.ts';

class NumberEntity {
  static #typeUuid = '0f7b46ea-451d-40f2-9a34-3a4530667814';

  readonly previous: NodeId | undefined;
  readonly id: string;

  constructor(nav: BedrockNavigator, entityId: NodeId) {
    assert(nav.getTypeOfEntity(entityId) === nav.lookupId(NumberEntity.#typeUuid));
    this.id = entityId;

    this.previous = nav.tryGetTrueProperty(entityId, 'previous', new ConditionalRelationshipSchema({
      nav,
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

class CompilerCache {
  readonly nav: BedrockNavigator;
  readonly #inputs: Set<NodeId>;
  readonly #outputs: Set<NodeId>;
  readonly #typeSignatures: Set<NodeId>;
  readonly exitRelationshipSchema: ConditionalRelationshipSchema<'value'>;
  readonly numberLookup: NumberLookup;

  constructor(nav: BedrockNavigator) {
    this.nav = nav;

    const inputParsedRelationships = new RelationshipSchema({
      data: nav.data,
      typeId: nav.lookupId('4fa938aa-3d98-4e79-8eac-4aad749ffaa9'),
      fieldNameToId: {
        target: nav.lookupId('0f38cd20-0930-43d4-abcd-0ecd0b28dd69'),
      } as const,
    }).listParsedRelationships();
    this.#inputs = new Set(inputParsedRelationships.map(r => r.fields.target));

    const outputParsedRelationships = new RelationshipSchema({
      data: nav.data,
      typeId: nav.lookupId('c9e807db-3c23-493a-9485-61f160557b3e'),
      fieldNameToId: {
        target: nav.lookupId('8201a837-9620-4a70-8653-040fcacde2c8'),
      } as const,
    }).listParsedRelationships();
    this.#outputs = new Set(outputParsedRelationships.map(r => r.fields.target));

    const typeSignaturesParsedRelationships = new RelationshipSchema({
      data: nav.data,
      typeId: nav.lookupId('c120e64e-ff23-4e63-9780-c426657a56a5'),
      fieldNameToId: {
        target: nav.lookupId('bbb78612-a804-40f4-93ff-4bf9518f1d98'),
      } as const,
    }).listParsedRelationships();
    this.#typeSignatures = new Set(typeSignaturesParsedRelationships.map(r => r.fields.target));

    this.exitRelationshipSchema = new ConditionalRelationshipSchema({
      nav,
      typeId: nav.lookupId('86b33c24-e4c1-4790-a4d9-1c8af3030b34'),
      fieldNameToId: {
        value: nav.lookupId('381dde34-25e1-4c1b-a3f3-762d9ada9f9c'),
      } as const,
    });

    this.numberLookup = new NumberLookup(nav);
  }

  isInput(nodeId: NodeId): boolean {
    return this.#inputs.has(nodeId);
  }

  isOutput(nodeId: NodeId): boolean {
    return this.#outputs.has(nodeId);
  }

  isTypeSignature(nodeId: NodeId): boolean {
    return this.#typeSignatures.has(nodeId);
  }
}

/** Converts a node-id with arbitrary characters into a literal that can be used in JS. */
function nodeIdToLiteral(nodeId: NodeId) {
  return '$_' + encodeURIComponent(nodeId)
    .replaceAll('%', '$');
}

function compileRelationship(cc: CompilerCache, relationshipId: NodeId): { code: string, inFnDef: string | undefined } | undefined {
  const relationship = cc.nav.lookupRelationship(relationshipId);
  const relationshipType = cc.nav.getRelationshipType(relationship);
  if (relationshipType === cc.nav.typeRelationshipSchema.typeId) {
    const { target: targetId, type: typeId } = cc.nav.typeRelationshipSchema.fieldNameToId;
    const target = relationship[targetId]!;
    const type = relationship[typeId]!;

    assert(!cc.nav.isVar(target));
    const maybeNumber = cc.numberLookup.entityIdToValue[target];
    const object = maybeNumber === undefined
      ? `{ $repr: "<type:${type.replaceAll('"', '').replaceAll('\\', '')}>" }`
      : `{ $repr: "${maybeNumber}" }`;
    return { code: `const ${nodeIdToLiteral(target)} = ${object};`, inFnDef: undefined };
  } else if (relationshipType === cc.exitRelationshipSchema.typeId) {
    // This is handled elsewhere.
    return undefined;
  } else {
    const inputs: string[] = [];
    const outputs: string[] = [];
    let outputType: 'var' | 'decl' | undefined;
    for (const [key, value] of Object.entries(relationship)) {
      if (cc.isInput(key)) {
        inputs.push(key);
      } else if (cc.isOutput(key)) {
        outputs.push(key);
        const outputVar = relationship[key]!;
        if (outputType === undefined) {
          outputType = cc.nav.isVar(outputVar) ? 'var' : 'decl';
        } else {
          assert(outputType === (cc.nav.isVar(outputVar) ? 'var' : 'decl'), 'If one output is a variable, all must be a variable.');
        }
      }
    }

    // Always using the same order is important, because the resulting string that gets built is compared with other strings.
    inputs.sort((a, b) => a.localeCompare(b));
    outputs.sort((a, b) => a.localeCompare(b));

    assert(outputType !== undefined, 'Expected the relationship to have an output.');

    if (outputType === 'var') {
      const args: string[] = [];
      for (const input of inputs) {
        const inputVar = relationship[input]!;
        assert(!cc.nav.isVar(inputVar), 'Not implemented yet');
        args.push(`${nodeIdToLiteral(input)}: ${nodeIdToLiteral(inputVar)}`);
      }

      const outputFields: string[] = [];
      for (const output of outputs) {
        const outputVar = relationship[output]!;
        outputFields.push(`${nodeIdToLiteral(output)}: ${nodeIdToLiteral(outputVar)}`);
      }

      const code = `const { ${outputFields.join(', ')} } = ${nodeIdToLiteral(relationshipType)}({ ${args.join(', ')} })`;

      return { code, inFnDef: undefined };
    } else if (outputType === 'decl') {
      const params = inputs.map(input => nodeIdToLiteral(input)).join(', ');
      const inFnDef = `function ${nodeIdToLiteral(relationshipType)}({ ${params} })`;

      const conditions: string[] = [];
      for (const input of inputs) {
        const inputVar = relationship[input]!;
        assert(!cc.nav.isVar(inputVar), 'Not implemented yet');
        conditions.push(`${nodeIdToLiteral(input)} === ${nodeIdToLiteral(inputVar)}`);
      }

      const outputFields: string[] = [];
      for (const output of outputs) {
        const outputVar = relationship[output]!;
        outputFields.push(`${nodeIdToLiteral(output)}: ${nodeIdToLiteral(outputVar)}`);
      }

      const code = `if (${conditions.join(' && ')}) return { ${outputFields.join(', ')} };`;
      return { code, inFnDef };
    } else {
      throw new UnreachableCaseError(outputType);
    }
  }
}

function compileProgram(cc: CompilerCache): string {
  const statementsByFnDef = new Map<string | undefined, string[]>();
  for (const relationship of cc.nav.data.relationships) {
    const relationshipId = relationship[cc.nav.relationshipIdKey];
    if (relationshipId === undefined) {
      continue;
    }
    if (!cc.nav.isRule(relationshipId)) {
      continue;
    }

    const compiled = compileRelationship(cc, relationshipId);
    if (compiled === undefined) {
      continue;
    }
    const { inFnDef, code } = compiled;

    const codeInScope = statementsByFnDef.get(inFnDef) ?? [];
    codeInScope.push(code);
    statementsByFnDef.set(inFnDef, codeInScope);
  }

  const result: string[] = [];
  for (const [fnDef, statements] of statementsByFnDef) {
    if (fnDef === undefined) continue;
    result.push(
      `${fnDef} {`,
      ...statements.map(line => '  ' + line),
      '  throw new Error("Called with invalid arguments");',
      '}',
      '',
    );
  }

  const parsedOutputRelationships = cc.exitRelationshipSchema.listTrueParsedRelationships();
  assert(parsedOutputRelationships.length === 1, `There should be exactly one output, ${parsedOutputRelationships.length} found.`);
  const finalNodeId = parsedOutputRelationships[0]!.fields.value.value;
  const finalLine = `console.log("OUTPUT:", ${nodeIdToLiteral(finalNodeId)}.$repr);`;

  return [
    ...result,
    ...statementsByFnDef.get(undefined) ?? [],
    '',
    finalLine,
  ].join('\n');
}

export function main(bedrockData: BedrockData) {
  const nav = new BedrockNavigator(bedrockData);
  const cc = new CompilerCache(nav);

  const result = compileProgram(cc);

  nav.assertAllMarkedAsCompiled();

  return result;
}
