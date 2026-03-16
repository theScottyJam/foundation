import assert from 'node:assert/strict';
import {
  BedrockNavigator,
  RelationshipSchema,
  ConditionalRelationshipSchema,
  type NodeId,
  type BedrockData,
  type Relationship,
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
  readonly andRelationshipSchema: ConditionalRelationshipSchema<'left' | 'right'>;
  readonly notRelationshipSchema: ConditionalRelationshipSchema<'right'>;
  readonly ifThenRelationshipSchema: ConditionalRelationshipSchema<'left' | 'right'>;
  readonly isRelationshipSchema: ConditionalRelationshipSchema<'left' | 'right'>;
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

    this.andRelationshipSchema = new ConditionalRelationshipSchema({
      nav,
      typeId: nav.lookupId('876a450c-778d-44a3-aae4-e4abd21b6cf0'),
      fieldNameToId: {
        left: nav.lookupId('96a0773b-d697-4397-a83e-c5dccb4287d9'),
        right: nav.lookupId('46560cd5-7339-4755-86bf-2ec963b6dfec'),
      } as const,
    });

    this.notRelationshipSchema = new ConditionalRelationshipSchema({
      nav,
      typeId: nav.lookupId('5833f84b-7ec6-4c14-b9b4-6afa554987ce'),
      fieldNameToId: {
        right: nav.lookupId('52acc525-0ddf-4b4f-acac-4c92c45fd2a5'),
      } as const,
    });

    this.ifThenRelationshipSchema = new ConditionalRelationshipSchema({
      nav,
      typeId: nav.lookupId('0c715b0f-0beb-41ea-809a-cbb0a4e4ab4d'),
      fieldNameToId: {
        left: nav.lookupId('2fb3e027-21cd-4dc7-95ec-e73a3956f1f9'),
        right: nav.lookupId('73528fa9-2ce9-432c-962a-365c337406c8'),
      } as const,
    });

    this.isRelationshipSchema = new ConditionalRelationshipSchema({
      nav,
      typeId: nav.lookupId('4b33c2ce-1303-40d6-8053-237ae570c5b4'),
      fieldNameToId: {
        left: nav.lookupId('facdc04f-fbc0-489d-88a5-5f59f8eb624e'),
        right: nav.lookupId('c1fbd400-9fe0-47f6-80db-da450e246011'),
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

function buildFnDef(cc: CompilerCache, relationship: Relationship) {
  const inputs: string[] = [];
  for (const key of Object.keys(relationship)) {
    if (cc.isInput(key)) {
      inputs.push(key);
    }
  }

  // Always using the same order is important, because the resulting string that gets built is compared with other strings.
  inputs.sort((a, b) => a.localeCompare(b));

  const relationshipType = cc.nav.getRelationshipType(relationship);
  const params = inputs.map(input => nodeIdToLiteral(input)).join(', ');
  return `function ${nodeIdToLiteral(relationshipType)}({ ${params} })`;
}

function buildConditionForFn(cc: CompilerCache, relationship: Relationship): { check: string, declares: string[] } {
  const inputs: string[] = [];
  for (const key of Object.keys(relationship)) {
    if (cc.isInput(key)) {
      inputs.push(key);
    }
  }

  const conditions: string[] = [];
  const declares: string[] = [];
  for (const input of inputs) {
    const inputVar = relationship[input]!;
    if (cc.nav.isVar(inputVar)) {
      declares.push(`var ${nodeIdToLiteral(inputVar)} = ${nodeIdToLiteral(input)};`);
    } else {
      conditions.push(`${nodeIdToLiteral(input)} === ${nodeIdToLiteral(inputVar)}`);
    }
  }

  const check = conditions.length === 0 ? 'true' : conditions.join(' && ');
  return { check, declares };
}

function compileFnCall(cc: CompilerCache, relationship: Relationship) {
  const relationshipType = cc.nav.getRelationshipType(relationship);

  const inputs: string[] = [];
  const outputs: string[] = [];
  for (const key of Object.keys(relationship)) {
    if (cc.isInput(key)) {
      inputs.push(key);
    }
    if (cc.isOutput(key)) {
      outputs.push(key);
    }
  }

  const args: string[] = [];
  for (const input of inputs) {
    const inputVar = relationship[input]!;
    args.push(`${nodeIdToLiteral(input)}: ${nodeIdToLiteral(inputVar)}`);
  }

  const outputFields: string[] = [];
  for (const output of outputs) {
    const outputVar = relationship[output]!;
    outputFields.push(`${nodeIdToLiteral(output)}: ${nodeIdToLiteral(outputVar)}`);
  }

  const code = `var { ${outputFields.join(', ')} } = ${nodeIdToLiteral(relationshipType)}({ ${args.join(', ')} })`;

  return code;
}

interface Context {
  readonly returnVar: NodeId
}

function compileRelationshipAsExpression(cc: CompilerCache, ctx: Context, relationshipId: NodeId): string {
  const relationship = cc.nav.lookupRelationship(relationshipId);
  const relationshipType = cc.nav.getRelationshipType(relationship);

  if (relationshipType === cc.andRelationshipSchema.typeId) {
    const parsedRelationship = ConditionalRelationshipSchema.assertAllExpressions(
      cc.andRelationshipSchema.parse(relationship),
    );

    return (
      '(' +
      compileRelationshipAsExpression(cc, ctx, parsedRelationship.fields.left.value) +
      ' && ' +
      compileRelationshipAsExpression(cc, ctx, parsedRelationship.fields.right.value) +
      ')'
    );
  } else if (relationshipType === cc.notRelationshipSchema.typeId) {
    const parsedRelationship = ConditionalRelationshipSchema.assertAllExpressions(
      cc.notRelationshipSchema.parse(relationship),
    );

    return '!' + compileRelationshipAsExpression(cc, ctx, parsedRelationship.fields.right.value);
  } else if (relationshipType === cc.isRelationshipSchema.typeId) {
    const parsedRelationship = cc.isRelationshipSchema.parse(relationship);
    assert(['var', 'value'].includes(parsedRelationship.fields.left.type), `The left operand of 'is' must be a var or value. ${JSON.stringify(relationship)}`);
    assert(['var', 'value'].includes(parsedRelationship.fields.right.type), `The right operand of 'is' must be a var or value. ${JSON.stringify(relationship)}`);

    return (
      '(' +
      nodeIdToLiteral(parsedRelationship.fields.left.value) +
      ' === ' +
      nodeIdToLiteral(parsedRelationship.fields.right.value) +
      ')'
    );
  } else {
    throw new Error(`Unsupported relationship type in expression "${relationshipType}"`);
  }
}

function compileRelationshipInFn(cc: CompilerCache, ctx: Context, relationshipId: NodeId): string[] {
  const relationship = cc.nav.lookupRelationship(relationshipId);
  const relationshipType = cc.nav.getRelationshipType(relationship);
  if (relationshipType === cc.andRelationshipSchema.typeId) {
    const parsedRelationship = ConditionalRelationshipSchema.assertAllExpressions(
      cc.andRelationshipSchema.parse(relationship),
    );

    return [
      ...compileRelationshipInFn(cc, ctx, parsedRelationship.fields.left.value),
      ...compileRelationshipInFn(cc, ctx, parsedRelationship.fields.right.value),
    ];
  } else if (relationshipType === cc.ifThenRelationshipSchema.typeId) {
    const parsedRelationship = ConditionalRelationshipSchema.assertAllExpressions(
      cc.ifThenRelationshipSchema.parse(relationship),
    );

    return [
      `if (${compileRelationshipAsExpression(cc, ctx, parsedRelationship.fields.left.value)}) {`,
      ...compileRelationshipInFn(cc, ctx, parsedRelationship.fields.right.value)
        .map(line => '  ' + line),
      '}',
    ];
  } else if (relationshipType === cc.isRelationshipSchema.typeId) {
    const parsedRelationship = cc.isRelationshipSchema.parse(relationship);
    assert(parsedRelationship.fields.left.type === 'var', `The left operand of 'is' must be a var. ${JSON.stringify(relationship)}`);
    assert(['var', 'value'].includes(parsedRelationship.fields.right.type), `The right operand of 'is' must be a var or value. ${JSON.stringify(relationship)}`);

    return [`var ${nodeIdToLiteral(parsedRelationship.fields.left.value)} = ${nodeIdToLiteral(parsedRelationship.fields.right.value)};`];
  } else {
    return [compileFnCall(cc, relationship)];
  }
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
      : `{ $repr: "${maybeNumber}", $type: "numb" }`;
    return { code: `const ${nodeIdToLiteral(target)} = ${object};`, inFnDef: undefined };
  } else if (relationshipType === cc.exitRelationshipSchema.typeId) {
    // This is handled elsewhere.
    return undefined;
  } else if (relationshipType === cc.andRelationshipSchema.typeId) {
    const parsedRelationship = ConditionalRelationshipSchema.assertAllExpressions(
      cc.andRelationshipSchema.parse(relationship),
    );

    assert(cc.isTypeSignature(parsedRelationship.fields.left.value));
    const signatureRelationship = cc.nav.lookupRelationship(parsedRelationship.fields.left.value);
    const inFnDef = buildFnDef(cc, signatureRelationship);
    const { check, declares } = buildConditionForFn(cc, signatureRelationship);

    let output: NodeId | undefined;
    for (const key of Object.keys(signatureRelationship)) {
      if (cc.isOutput(key)) {
        assert(output === undefined, 'Only one output can currently be defined in a procedural function definition.');
        output = key;
      }
    }
    assert(output !== undefined, 'An output is required.');
    const outputVar = signatureRelationship[output]!;
    assert(cc.nav.isVar(outputVar), 'The output must be a var.');
    const ctx: Context = { returnVar: outputVar }; // <-- This ctx object isn't really needed.

    const lines = compileRelationshipInFn(cc, ctx, parsedRelationship.fields.right.value);
    const code = [
      `if (${check}) {`,
      ...[...declares, ...lines].map(line => '    ' + line),
      `    return { ${nodeIdToLiteral(output)}: ${nodeIdToLiteral(outputVar)} };`,
      '  }',
    ].join('\n');
    return { code, inFnDef };
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

    assert(outputType !== undefined, 'Expected the relationship to have an output.');

    if (outputType === 'var') {
      const code = compileFnCall(cc, relationship);
      return { code, inFnDef: undefined };
    } else if (outputType === 'decl') {
      const inFnDef = buildFnDef(cc, relationship);
      const { check, declares } = buildConditionForFn(cc, relationship);
      assert(declares.length === 0, 'Declarations in a single mapping is not supported'); // Not sure if this would even be reachable.

      const outputFields: string[] = [];
      for (const output of outputs) {
        const outputVar = relationship[output]!;
        outputFields.push(`${nodeIdToLiteral(output)}: ${nodeIdToLiteral(outputVar)}`);
      }

      const code = `if (${check}) return { ${outputFields.join(', ')} };`;
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

  // <--
  // nav.assertAllMarkedAsCompiled();

  return result;
}
