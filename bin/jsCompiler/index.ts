import assert from 'node:assert/strict';
import { BedrockNavigator, RelationshipSchema, type NodeId } from './BedrockNavigator.ts';
import { throwIndexOutOfBounds } from '../util.ts';
import type { BedrockData, RelationshipData } from '../types.ts';

type CompiledLine = {
  readonly type: 'statement'
  readonly line: string
  /** What variables does this statement need provided? (Dependencies on functions are excluded) */
  readonly varDependencies: NodeId[]
  /** If this statement assigns to a variable (a node), what node does it assign to? */
  readonly supplies: NodeId | undefined
} | {
  readonly type: 'fnDef'
  readonly content: string
};

class CompilerCache {
  readonly nav: BedrockNavigator;
  readonly #processedNodeIds = new Map<NodeId, { inFn: NodeId | undefined }>();
  readonly #inFn: NodeId[] = [];
  /** Maps node-ids that have been processed to the functions they are local to when processed. */
  readonly exitRelationshipSchema: RelationshipSchema<'value'>;
  // readonly andRelationshipSchema: RelationshipSchema<'left' | 'right'>;
  // readonly notRelationshipSchema: RelationshipSchema<'right'>;
  // readonly ifThenRelationshipSchema: RelationshipSchema<'left' | 'right'>;
  // readonly isRelationshipSchema: RelationshipSchema<'left' | 'right'>;

  constructor(nav: BedrockNavigator) {
    this.nav = nav;

    this.exitRelationshipSchema = new RelationshipSchema({
      typeId: nav.fromUuid('86b33c24-e4c1-4790-a4d9-1c8af3030b34'),
      fieldNameToId: {
        value: nav.fromUuid('381dde34-25e1-4c1b-a3f3-762d9ada9f9c'),
      } as const,
    });

    // this.andRelationshipSchema = new RelationshipSchema({
    //   typeId: nav.fromUuid('876a450c-778d-44a3-aae4-e4abd21b6cf0'),
    //   fieldNameToId: {
    //     left: nav.fromUuid('96a0773b-d697-4397-a83e-c5dccb4287d9'),
    //     right: nav.fromUuid('46560cd5-7339-4755-86bf-2ec963b6dfec'),
    //   } as const,
    // });

    // this.notRelationshipSchema = new RelationshipSchema({
    //   typeId: nav.fromUuid('5833f84b-7ec6-4c14-b9b4-6afa554987ce'),
    //   fieldNameToId: {
    //     right: nav.fromUuid('52acc525-0ddf-4b4f-acac-4c92c45fd2a5'),
    //   } as const,
    // });

    // this.ifThenRelationshipSchema = new RelationshipSchema({
    //   typeId: nav.fromUuid('0c715b0f-0beb-41ea-809a-cbb0a4e4ab4d'),
    //   fieldNameToId: {
    //     left: nav.fromUuid('2fb3e027-21cd-4dc7-95ec-e73a3956f1f9'),
    //     right: nav.fromUuid('73528fa9-2ce9-432c-962a-365c337406c8'),
    //   } as const,
    // });

    // this.isRelationshipSchema = new RelationshipSchema({
    //   typeId: nav.fromUuid('4b33c2ce-1303-40d6-8053-237ae570c5b4'),
    //   fieldNameToId: {
    //     left: nav.fromUuid('facdc04f-fbc0-489d-88a5-5f59f8eb624e'),
    //     right: nav.fromUuid('c1fbd400-9fe0-47f6-80db-da450e246011'),
    //   } as const,
    // });
  }

  /**
   * Node IDs should be marked with this function when you're about to start processing them.
   * Returns true if they have already been processed, so you don't need to double-compile it.
   * Throws if they have already been processed, but local to a different function.
   *
   * The thing being marked as processed is the line that produces the value tied to that node ID,
   * which may be a function definition (where that node ID is the function name), a function call
   * (where the node ID is what gets assigned from the result), etc.
   *
   * Use {@link inGlobalScope} for functions, which always get defined in the global scope.
   */
  markAsProcessed(nodeId: NodeId, opts: { inGlobalScope?: boolean } = {}): boolean {
    const { inGlobalScope = false } = opts;

    const existing = this.#processedNodeIds.get(nodeId);
    const scopeToDefineIn = inGlobalScope ? undefined : this.#inFn.at(-1); // May be undefined

    if (existing === undefined) {
      this.#processedNodeIds.set(nodeId, { inFn: scopeToDefineIn });
      return false;
    }

    if (existing.inFn === scopeToDefineIn) {
      return true;
    }

    const details = `"${existing.inFn ?? 'global'}" and "${scopeToDefineIn ?? 'global'}"`;
    throw new Error(`The same nodeID, ${nodeId}, got compiled into two incompatible scopes. (${details})`);
  }

  inFn<T>(fnNodeId: NodeId, callback: () => T): T {
    assert(this.#inFn !== undefined, `Can not enter a function when you are already in one. Function node trying to enter: ${fnNodeId}.`);
    this.#inFn.push(fnNodeId);
    try {
      return callback();
    } finally {
      this.#inFn.pop();
    }
  }
}

/**
 * If you're inside a function, provide the `params` list so we know what param nodeIds are available,
 * which is needed as part of determining order via variable dependency.
 */
function reorderCompiledLines(compiledLines: CompiledLine[], opts: { params?: NodeId[] } = {}): CompiledLine[] {
  const fnDefs = compiledLines.filter(cl => cl.type === 'fnDef');
  const unsortedStatements = compiledLines.filter(cl => cl.type === 'statement');

  const seen = new Set<NodeId>(opts.params ?? []);
  const queue = [...unsortedStatements];
  const statements: CompiledLine[] = [];
  let loopCounter = queue.length;
  while (queue.length > 0) {
    const statement = queue.pop() ?? throwIndexOutOfBounds();
    if (statement.varDependencies.every(dep => seen.has(dep))) {
      if (statement.supplies !== undefined) {
        seen.add(statement.supplies);
      }
      statements.push(statement);
      loopCounter = queue.length;
    } else {
      queue.unshift(statement);
      loopCounter--;
      assert(loopCounter >= 0, 'Infinite dependency loop detected');
    }
  }

  return [...fnDefs, ...statements];
}

/** Converts a node-id with arbitrary characters into a literal that can be used in JS. */
function nodeIdToLiteral(nodeId: NodeId) {
  // All variables start with "_" or "$" to avoid conflicting with the language's built-in variables.

  // Try to keep things somewhat human-readable if able.
  const parts = nodeId.split(':');
  if (parts.length === 2 && !Number.isNaN(Number(parts[0])) && parts[1]!.match(/^[a-zA-Z0-9_$]+$/) !== null) {
    return '$' + parts[0] + '_' + parts[1];
  }

  // Fall back to a quick-and-dirty generic encoding algorithm.
  return '$$' + encodeURIComponent(nodeId)
    .replaceAll('%', '$');
}

/** {@link sourceRelationship} is where this nodeId was found, so if we fail to look it up, we know what line to highlight. */
function compileFnDefinition(cc: CompilerCache, fnNodeId: NodeId, sourceRelationship: RelationshipData): CompiledLine[] {
  if (cc.markAsProcessed(fnNodeId, { inGlobalScope: true })) return [];

  const fnSignatures = cc.nav.lookupFnSignatureIds(fnNodeId)
    .map(relationshipId => cc.nav.lookupRelationship(relationshipId));
  assert(fnSignatures.length === 1, `There should be exactly one function signature per function. ${fnNodeId} has ${fnSignatures.length}.`);
  const fnSignature = fnSignatures[0] ?? throwIndexOutOfBounds();

  const { inputNodeIds, outputNodeId } = cc.nav.getInputsAndOutputs(fnSignature);

  const declares: string[] = [];
  const paramVars: string[] = [];
  for (const input of inputNodeIds) {
    const inputVar = fnSignature.mapping[input] ?? throwIndexOutOfBounds();
    if (cc.nav.isVar(inputVar)) {
      declares.push(`var ${nodeIdToLiteral(inputVar)} = ${nodeIdToLiteral(input)};`);
      paramVars.push(inputVar);
    } else {
      cc.nav.reportError(`All function signature inputs must be a variable. ${input} was not.`, fnSignature);
    }
  }

  const outputVar = fnSignature.mapping[outputNodeId] ?? throwIndexOutOfBounds();
  if (!cc.nav.isVar(outputVar)) {
    cc.nav.reportError("The function signature's output must be a variable.", fnSignature);
  }

  const statements = cc.inFn(fnNodeId, () => {
    for (const input of inputNodeIds) {
      const inputVar = fnSignature.mapping[input] ?? throwIndexOutOfBounds();
      assert(!cc.markAsProcessed(inputVar));
    }
    return compileProducerOfNodeId(cc, outputVar, fnSignature);
  });
  const dependentCode = reorderCompiledLines(statements, { params: paramVars });
  const bodyLines = dependentCode.filter(c => c.type === 'statement').map(c => c.line);
  const dependentFnDefs = dependentCode.filter(c => c.type === 'fnDef');
  const body = [
    ...[...declares, ...bodyLines].map(line => '  ' + line),
    `  return { ${nodeIdToLiteral(outputNodeId)}: ${nodeIdToLiteral(outputVar)} };`,
  ].join('\n');

  const params = inputNodeIds.map(input => nodeIdToLiteral(input)).join(', ');
  return [
    ...dependentFnDefs,
    {
      type: 'fnDef',
      content: `function ${nodeIdToLiteral(fnNodeId)}({ ${params} }) {\n${body}\n}`,
    },
  ];
}

function compileFunctionCall(cc: CompilerCache, nodeId: NodeId, sourceRelationship: RelationshipData): CompiledLine[] {
  if (cc.markAsProcessed(nodeId)) return [];

  const relationships = cc.nav.nonSignatureRelationshipsFromOutputVarId(nodeId, sourceRelationship);
  assert(relationships.length === 1, `Only one producer per variable is currently supported, found ${relationships.length} for ${nodeId}`);
  const relationship = relationships[0] ?? throwIndexOutOfBounds();
  const { inputNodeIds, outputNodeId } = cc.nav.getInputsAndOutputs(relationship);

  const result: CompiledLine[] = [];
  result.push(...compileFnDefinition(cc, relationship.type, relationship));
  for (const nodeId of [...inputNodeIds, outputNodeId]) {
    const value = relationship.mapping[nodeId] ?? throwIndexOutOfBounds();
    result.push(...compileProducerOfNodeId(cc, value, relationship));
  }

  result.push({
    type: 'statement',
    line: (
      'var { ' +
      nodeIdToLiteral(outputNodeId) +
      ': ' +
      nodeIdToLiteral(relationship.mapping[outputNodeId] ?? throwIndexOutOfBounds()) +
      ' } = ' +
      nodeIdToLiteral(relationship.type) +
      '({ ' +
      inputNodeIds.map(nodeId => {
        const value = relationship.mapping[nodeId] ?? throwIndexOutOfBounds();
        return nodeIdToLiteral(nodeId) + ': ' + nodeIdToLiteral(value);
      }).join(', ') +
      ' });'
    ),
    varDependencies: inputNodeIds.map(nodeId => relationship.mapping[nodeId] ?? throwIndexOutOfBounds()),
    supplies: nodeId,
  });

  return result;
}

function compileLiteralAssignment(cc: CompilerCache, nodeId: NodeId): CompiledLine[] {
  if (cc.markAsProcessed(nodeId)) return [];

  const type = cc.nav.tryGetTypeOfEntity(nodeId);
  const object = type === undefined
    ? '{ $repr: "<unknown type>" }'
    : `{ $repr: "<type:${type.replaceAll('"', '').replaceAll('\\', '')}>" }`;

  return [{
    type: 'statement',
    line: `const ${nodeIdToLiteral(nodeId)} = ${object};`,
    varDependencies: [],
    supplies: nodeId,
  }];
}

/**
 * {@link sourceRelationship} is where this nodeId was found, so if we fail to look it up, we know what line to highlight.
 * It is _not_ the relationship being compiled by this function, it's a relationship that uses JS variables, and we need compile
 * whatever generates those variables.
 */
function compileProducerOfNodeId(cc: CompilerCache, nodeId: NodeId, sourceRelationship: RelationshipData): CompiledLine[] {
  if (!cc.nav.isVar(nodeId)) {
    return compileLiteralAssignment(cc, nodeId);
  } else {
    return compileFunctionCall(cc, nodeId, sourceRelationship);
  }
}

function compileProgram(cc: CompilerCache): string {
  const parsedOutputRelationships = cc.exitRelationshipSchema.listParsedRelationships(cc.nav.data);
  assert(parsedOutputRelationships.length === 1, `There should be exactly one output, ${parsedOutputRelationships.length} found.`);
  const finalParsedRelationship = parsedOutputRelationships[0] ?? throwIndexOutOfBounds();
  const finalNodeId = finalParsedRelationship.fields.value;
  if (!cc.nav.isVar(finalNodeId)) {
    cc.nav.reportError('The final output must be a variable.', finalParsedRelationship.raw);
  }
  const statements: CompiledLine[] = [{
    type: 'statement',
    line: `console.log("OUTPUT:", ${nodeIdToLiteral(finalNodeId)}.$repr);`,
    varDependencies: [finalNodeId],
    supplies: undefined,
  }];

  const stack: { varId: NodeId, sourceRelationship: RelationshipData }[] = [
    { varId: finalNodeId, sourceRelationship: finalParsedRelationship.raw },
  ];
  while (stack.length > 0) {
    const { varId, sourceRelationship } = stack.pop() ?? throwIndexOutOfBounds();
    statements.push(...compileProducerOfNodeId(cc, varId, sourceRelationship));
  }

  return reorderCompiledLines(statements).map(s => s.type === 'statement' ? s.line : s.content).join('\n');
}

export function bedrockToJs(bedrockData: BedrockData) {
  const nav = new BedrockNavigator(bedrockData);
  const cc = new CompilerCache(nav);

  const result = compileProgram(cc);

  return result;
}
