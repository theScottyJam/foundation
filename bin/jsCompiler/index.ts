import assert from 'node:assert/strict';
import { BedrockNavigator, RelationshipSchema, type ParsedRelationship, type NodeId } from './BedrockNavigator.ts';
import { throwIndexOutOfBounds } from '../util.ts';
import type { BedrockData, RelationshipData } from '../types.ts';

interface LineCondition {
  /** What will be placed inside the if (...) */
  readonly condition: string
  readonly varDependencies: NodeId[]
}

interface CompiledStatement {
  readonly type: 'statement'
  readonly line: string
  /** What variables does this statement need provided? (Dependencies on functions are excluded) */
  readonly varDependencies: NodeId[]
  /** If this statement assigns to a variable (a node), what node does it assign to? */
  readonly supplies: NodeId | undefined
  readonly conditionedOn?: LineCondition
  /** If true, it means this line should be in the global scope, it should not be inside whatever function is currently being compiled. */
  readonly global?: true
}

interface CompiledFnDef {
  readonly type: 'fnDef'
  readonly content: string
  readonly varDependencies: NodeId[]
}

type CompiledLine = CompiledStatement | CompiledFnDef;

/** Represents an assignment (isRelationship) that's optionally conditioned on something (thenRelationship). */
interface BooleanOperatorTree {
  readonly isRelationship: ParsedRelationship<'left' | 'right' | 'result'>
  readonly thenRelationship?: ParsedRelationship<'left' | 'right' | 'result'>
}

class CompilerCache {
  readonly nav: BedrockNavigator;
  readonly #processedNodeIds = new Map<NodeId, { inFn: NodeId | undefined }>();
  readonly #inFn: RelationshipData[] = [];
  /** Maps node-ids that have been processed to the functions they are local to when processed. */
  readonly exitRelationshipSchema: RelationshipSchema<'value'>;
  // readonly andRelationshipSchema: RelationshipSchema<'left' | 'right'>;
  readonly notRelationshipSchema: RelationshipSchema<'operand'>;
  readonly ifThenRelationshipSchema: RelationshipSchema<'left' | 'right' | 'result'>;
  readonly isRelationshipSchema: RelationshipSchema<'left' | 'right' | 'result'>;
  readonly #mapIsLhsToBoolOperatorTrees: Map<NodeId, BooleanOperatorTree[]>;

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

    this.notRelationshipSchema = new RelationshipSchema({
      typeId: nav.fromUuid('5833f84b-7ec6-4c14-b9b4-6afa554987ce'),
      fieldNameToId: {
        operand: nav.fromUuid('52acc525-0ddf-4b4f-acac-4c92c45fd2a5'),
      } as const,
    });

    this.ifThenRelationshipSchema = new RelationshipSchema({
      typeId: nav.fromUuid('0c715b0f-0beb-41ea-809a-cbb0a4e4ab4d'),
      fieldNameToId: {
        left: nav.fromUuid('2fb3e027-21cd-4dc7-95ec-e73a3956f1f9'),
        right: nav.fromUuid('73528fa9-2ce9-432c-962a-365c337406c8'),
        result: nav.fromUuid('89631b26-ee75-4d5f-869e-dc0c9ff65057'),
      } as const,
    });

    this.isRelationshipSchema = new RelationshipSchema({
      typeId: nav.fromUuid('4b33c2ce-1303-40d6-8053-237ae570c5b4'),
      fieldNameToId: {
        left: nav.fromUuid('facdc04f-fbc0-489d-88a5-5f59f8eb624e'),
        right: nav.fromUuid('c1fbd400-9fe0-47f6-80db-da450e246011'),
        result: nav.fromUuid('57f0bba0-cfa6-49c1-8727-bc1f0b577a18'),
      } as const,
    });

    const trueVal = nav.fromUuid('a27cca07-59ad-4394-a602-7b114f0d5b3b');

    const traverseBooleanOperators = (ifThenRelationship: ParsedRelationship<'left' | 'right' | 'result'>): BooleanOperatorTree => {
      const rhs = ifThenRelationship.fields.right;
      if (!nav.isVar(rhs)) {
        nav.reportError('Expected the right-hand side of this "then" operator to be a variable.', ifThenRelationship.raw);
      }

      const nextRelationships = nav.nonSignatureRelationshipsFromOutputVarId(rhs, ifThenRelationship.raw);
      if (nextRelationships.length !== 1) {
        nav.reportError(
          `The output variable of this relationship is connected to ${nextRelationships.length} relationships - it should be connected to one.`,
          ifThenRelationship.raw,
        );
      }
      const nextRelationship = nextRelationships[0] ?? throwIndexOutOfBounds();

      if (nextRelationship.type === this.isRelationshipSchema.typeId) {
        return {
          isRelationship: this.isRelationshipSchema.parse(nav.data, nextRelationship),
        };
      }

      nav.reportError(
        'Expected this to be an "is" relationship, because its output is used in another boolean operator.',
        nextRelationship,
      );
    };

    const mapIsLhsToBoolOperatorTrees = new Map<NodeId, BooleanOperatorTree[]>();
    for (const relationship of nav.data.relationships) {
      if (relationship.type === this.ifThenRelationshipSchema.typeId) {
        const parsedRelationship = this.ifThenRelationshipSchema.parse(nav.data, relationship);
        if (parsedRelationship.fields.result === trueVal) {
          const relationshipTree = traverseBooleanOperators(parsedRelationship);
          const values = mapIsLhsToBoolOperatorTrees.get(relationshipTree.isRelationship.fields.left) ?? [];
          mapIsLhsToBoolOperatorTrees.set(relationshipTree.isRelationship.fields.left, values);
          values.push({
            isRelationship: relationshipTree.isRelationship,
            thenRelationship: parsedRelationship,
          });
        }
      }

      if (relationship.type === this.isRelationshipSchema.typeId) {
        const parsedRelationship = this.isRelationshipSchema.parse(nav.data, relationship);
        if (parsedRelationship.fields.result === trueVal) {
          const values = mapIsLhsToBoolOperatorTrees.get(parsedRelationship.fields.left) ?? [];
          mapIsLhsToBoolOperatorTrees.set(parsedRelationship.fields.left, values);
          values.push({
            isRelationship: parsedRelationship,
          });
        }
      }
    }
    this.#mapIsLhsToBoolOperatorTrees = mapIsLhsToBoolOperatorTrees;
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
   * Use {@link inGlobalScope} for values which always get defined in the global scope (such as functions).
   */
  markAsProcessed(nodeId: NodeId, opts: { inGlobalScope?: boolean } = {}): boolean {
    const { inGlobalScope = false } = opts;

    const existing = this.#processedNodeIds.get(nodeId);
    const scopeToDefineIn = inGlobalScope ? undefined : this.#inFn.at(-1)?.type;

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

  processWithinFn<T>(fnSignature: RelationshipData, callback: () => T): T {
    this.#inFn.push(fnSignature);
    try {
      return callback();
    } finally {
      this.#inFn.pop();
    }
  }

  inFn(): RelationshipData | undefined {
    return this.#inFn.at(-1);
  }

  lookupBoolTreesThatProducesVar(varId: NodeId): BooleanOperatorTree[] {
    return this.#mapIsLhsToBoolOperatorTrees.get(varId) ?? [];
  }
}

/**
 * If you're inside a function, provide the `assumeBound` list so we know what param nodeIds should be assumed to be available,
 * which is needed as part of determining order via variable dependency.
 * `assumeBound` can include parameters or variables defined external to the function.
 */
function reorderCompiledLines(
  compiledLines: CompiledLine[],
  opts: { assumeBound?: NodeId[] } = {},
): { fnDefs: CompiledFnDef[], globalLines: CompiledStatement[], lines: string[] } {
  const fnDefs = compiledLines.filter(l => l.type === 'fnDef');
  const unsortedStatements = compiledLines.filter(l => l.type === 'statement');

  const globalLines: CompiledStatement[] = [];
  const whatSuppliesWhat = new Map<NodeId, CompiledLine[]>();
  const suppliesCondition = new Set<NodeId>();
  const sortedStatements: (CompiledLine & { type: 'statement' })[] = [];
  {
    const seen = new Set<NodeId>(opts.assumeBound ?? []);
    const queue = [...unsortedStatements];
    let loopCounter = queue.length;
    while (queue.length > 0) {
      const statement = queue.pop() ?? throwIndexOutOfBounds();
      if (statement.varDependencies.every(dep => seen.has(dep))) {
        if (statement.supplies !== undefined) {
          seen.add(statement.supplies);
        }
        for (const dependency of statement.varDependencies) {
          const supplies = whatSuppliesWhat.get(dependency) ?? [];
          whatSuppliesWhat.set(dependency, supplies);
          supplies.push(statement);
        }
        for (const dependency of statement.conditionedOn?.varDependencies ?? []) {
          suppliesCondition.add(dependency);
        }
        (statement.global ? globalLines : sortedStatements).push(statement);
        loopCounter = queue.length;
      } else {
        queue.unshift(statement);
        loopCounter--;
        assert(loopCounter >= 0, 'Infinite dependency loop detected');
      }
    }
  }

  type NestedCompiledLine = CompiledStatement | {
    readonly type: 'condition'
    readonly condition: string
    readonly content: string[]
  };

  const nestedStatements: NestedCompiledLine[] = [];
  {
    let stack = [...sortedStatements];
    while (stack.length > 0) {
      const statement = stack.pop() ?? throwIndexOutOfBounds();
      if (statement.conditionedOn === undefined) {
        nestedStatements.push(statement);
        continue;
      }

      const statementsInThisConditionSet = new Set<CompiledLine>([statement]);
      const statementsInThisConditionList = [statement];
      const innerStack = [...stack];
      stack = [];
      while (innerStack.length > 0) {
        const iterStatement = innerStack.pop() ?? throwIndexOutOfBounds();
        if (iterStatement.supplies === undefined || suppliesCondition.has(iterStatement.supplies) || iterStatement.global) {
          stack.push(iterStatement);
          continue;
        }

        const targets = whatSuppliesWhat.get(iterStatement.supplies);
        // If targets is undefined, it may means it was targeting a function signature's return variable.
        if (targets === undefined || !targets.every(target => statementsInThisConditionSet.has(target))) {
          stack.push(iterStatement);
          continue;
        }

        statementsInThisConditionSet.add(iterStatement);
        statementsInThisConditionList.push(iterStatement);
      }
      statementsInThisConditionList.reverse();
      stack.reverse();

      nestedStatements.push({
        type: 'condition',
        condition: statement.conditionedOn.condition,
        content: statementsInThisConditionList.map(l => l.line),
      });
    }
    nestedStatements.reverse();
  }

  const lines = nestedStatements.flatMap(statement => {
    if (statement.type === 'statement') {
      return statement.line;
    } else {
      return [
        `if (${statement.condition}) {`,
        ...statement.content.map(line => '  ' + line),
        '}',
      ];
    }
  });
  return { fnDefs, globalLines, lines };
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

  if (fnSignatures.length > 0) {
    assert(fnSignatures.length === 1, `There should be at most one function signature per function. ${fnNodeId} has ${fnSignatures.length}.`);
    const fnSignature = fnSignatures[0] ?? throwIndexOutOfBounds();
    return compileFnDefinitionFromInstructions(cc, fnSignature);
  } else {
    return compileFnDefinitionFromMapping(cc, fnNodeId);
  }
}

/** Compiles a function in a traditional fashion - there should be a function signature and a function body. */
function compileFnDefinitionFromInstructions(cc: CompilerCache, fnSignature: RelationshipData): CompiledLine[] {
  const fnNodeId = fnSignature.type;
  const { inputNodeIds, outputNodeId } = cc.nav.getInputsAndOutputs(fnSignature);

  const compiledParamList: string[] = [];
  const paramVars: string[] = [];
  for (const input of inputNodeIds) {
    const inputVar = fnSignature.mapping[input] ?? throwIndexOutOfBounds();
    if (cc.nav.isVar(inputVar)) {
      compiledParamList.push(`${nodeIdToLiteral(input)}: ${nodeIdToLiteral(inputVar)}`);
      paramVars.push(inputVar);
    } else {
      cc.nav.reportError(`All function signature inputs must be a variable. ${input} was not.`, fnSignature);
    }
  }

  const outputVar = fnSignature.mapping[outputNodeId] ?? throwIndexOutOfBounds();
  if (!cc.nav.isVar(outputVar)) {
    cc.nav.reportError("The function signature's output must be a variable.", fnSignature);
  }

  const statements = cc.processWithinFn(fnSignature, () => {
    for (const input of inputNodeIds) {
      const inputVar = fnSignature.mapping[input] ?? throwIndexOutOfBounds();
      assert(!cc.markAsProcessed(inputVar));
    }
    return compileProducerOfNodeId(cc, outputVar, fnSignature);
  });

  // Find "free variables" - vars that need to be defined external to the function.
  const freeVars: NodeId[] = [];
  {
    const varsSupplied = new Set<NodeId>();
    const varsNeeded = new Set<NodeId>();
    for (const statement of statements) {
      if (statement.type === 'statement') {
        if (statement.supplies !== undefined) {
          varsSupplied.add(statement.supplies);
        }
        for (const dependent of statement.varDependencies) {
          varsNeeded.add(dependent);
        }
      }
    }

    for (const varNeeded of varsNeeded) {
      if (!varsSupplied.has(varNeeded) && !paramVars.includes(varNeeded)) {
        freeVars.push(varNeeded);
      }
    }
  }

  const freeVarStatements = freeVars.flatMap(freeVar => {
    assert(!cc.nav.isVar(freeVar), 'Free variables should not be marked as "var", as that marker indicates it is local to the function: ' + freeVar);
    return compileProducerOfNodeId(cc, freeVar, fnSignature);
  });

  const { fnDefs: dependentFnDefs, globalLines, lines: bodyLines } = reorderCompiledLines(statements, { assumeBound: [...paramVars, ...freeVars] });
  const body = [
    ...bodyLines.map(line => '  ' + line),
    `  return { ${nodeIdToLiteral(outputNodeId)}: ${nodeIdToLiteral(outputVar)} };`,
  ].join('\n');

  return [
    ...dependentFnDefs,
    ...globalLines,
    ...freeVarStatements,
    {
      type: 'fnDef',
      content: `function ${nodeIdToLiteral(fnNodeId)}({ ${compiledParamList.join(', ')} }) {\n${body}\n}`,
      varDependencies: freeVars,
    },
  ];
}

/** Looks for key-value pair relationships and compiles them into a function. */
function compileFnDefinitionFromMapping(cc: CompilerCache, fnNodeId: NodeId): CompiledLine[] {
  const mappings: string[] = [];
  let expectedParams: string[] | undefined;
  const dependents: CompiledLine[] = [];
  for (const relationship of cc.nav.findRelationshipsByType(cc.nav.data, fnNodeId)) {
    const { inputNodeIds, outputNodeId } = cc.nav.getInputsAndOutputs(relationship);
    if (inputNodeIds.length === 0) {
      cc.nav.reportError('At least one input must exist to build a mapping from this relationship.', relationship);
    }
    const inputValues = inputNodeIds.map(key => relationship.mapping[key] ?? throwIndexOutOfBounds());
    const outputValue = relationship.mapping[outputNodeId] ?? throwIndexOutOfBounds();
    if (inputValues.some(nodeId => cc.nav.isVar(nodeId)) || cc.nav.isVar(outputValue)) {
      continue;
    }

    expectedParams ??= inputNodeIds;
    if (inputNodeIds.some(nodeId => !expectedParams!.includes(nodeId)) || expectedParams.some(param => !inputNodeIds.includes(param))) {
      cc.nav.reportError('Not all mapping lines take the same set of inputs.', relationship);
    }

    const conditions = inputNodeIds.map((key, i) => {
      const value = nodeIdToLiteral(inputValues[i] ?? throwIndexOutOfBounds());
      return `${nodeIdToLiteral(key)} === ${value}`;
    });
    mappings.push(
      `  if (${conditions.join('&&')}) return { ${nodeIdToLiteral(outputNodeId)}: ${nodeIdToLiteral(outputValue)} }`,
    );
    dependents.push(
      ...inputValues.flatMap(value => compileProducerOfNodeId(cc, value, relationship)),
      ...compileProducerOfNodeId(cc, outputValue, relationship),
    );
  }

  assert(mappings.length > 0, `No function definition was found for ${fnNodeId}`);
  const params = expectedParams!.map(p => nodeIdToLiteral(p)).join(', ');
  const body = [
    ...mappings,
    "  throw new Error('Invalid Input')",
  ].join('\n');

  return [
    ...dependents,
    {
      type: 'fnDef',
      content: `function ${nodeIdToLiteral(fnNodeId)}({ ${params} }) {\n${body}\n}`,
      varDependencies: [],
    },
  ];
}

function compileFunctionCall(cc: CompilerCache, relationship: RelationshipData): CompiledLine[] {
  const { inputNodeIds, outputNodeId } = cc.nav.getInputsAndOutputs(relationship);

  const outputVar = relationship.mapping[outputNodeId] ?? throwIndexOutOfBounds();
  if (cc.markAsProcessed(outputVar)) return [];

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
      nodeIdToLiteral(outputVar) +
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
    supplies: outputVar,
  });

  return result;
}

function compileLiteralAssignment(cc: CompilerCache, nodeId: NodeId): CompiledLine[] {
  if (cc.markAsProcessed(nodeId, { inGlobalScope: true })) return [];

  const type = cc.nav.tryGetTypeOfEntity(nodeId);
  const object = type === undefined
    ? '{ $repr: "<unknown type>" }'
    : `{ $repr: "<type:${type.replaceAll('"', '').replaceAll('\\', '')}>" }`;

  return [{
    type: 'statement',
    line: `var ${nodeIdToLiteral(nodeId)} = ${object};`,
    varDependencies: [],
    supplies: nodeId,
    global: true,
  }];
}

function compileCondition(cc: CompilerCache, nodeId: string, sourceRelationship: RelationshipData): LineCondition {
  const relationships = cc.nav.nonSignatureRelationshipsFromOutputVarId(nodeId, sourceRelationship);
  if (relationships.length !== 1) {
    cc.nav.reportError(`Expected exactly one provider for ${nodeId}, got ${relationships.length}.`, sourceRelationship);
  }

  const relationship = relationships[0] ?? throwIndexOutOfBounds();

  if (relationship.type === cc.notRelationshipSchema.typeId) {
    const parsedRelationship = cc.notRelationshipSchema.parse(cc.nav.data, relationship);
    const operand = compileCondition(cc, parsedRelationship.fields.operand, relationship);
    return {
      condition: `!(${operand.condition})`,
      varDependencies: operand.varDependencies,
    };
  } else if (relationship.type === cc.isRelationshipSchema.typeId) {
    const parsedRelationship = cc.isRelationshipSchema.parse(cc.nav.data, relationship);
    const { left, right } = parsedRelationship.fields;
    return {
      condition: `${nodeIdToLiteral(left)} === ${nodeIdToLiteral(right)}`,
      varDependencies: [left, right],
    };
  } else {
    cc.nav.reportError('This relationship is not a supported boolean relationship.', relationship);
  }
}

function compileConditionalAssignments(cc: CompilerCache, boolTrees: BooleanOperatorTree[]): CompiledLine[] {
  return boolTrees.flatMap((boolTree): CompiledLine[] => {
    const conditionedOn = boolTree.thenRelationship !== undefined
      ? compileCondition(cc, boolTree.thenRelationship.fields.left, boolTree.thenRelationship.raw)
      : undefined;

    const { left, right } = boolTree.isRelationship.fields;
    return [
      ...compileProducerOfNodeId(cc, right, boolTree.isRelationship.raw),
      {
        type: 'statement',
        line: `var ${nodeIdToLiteral(left)} = ${nodeIdToLiteral(right)};`,
        varDependencies: [right, ...conditionedOn?.varDependencies ?? []],
        supplies: left,
        conditionedOn,
      },
    ];
  });
}

/**
 * {@link sourceRelationship} is where this nodeId was found, so if we fail to look it up, we know what line to highlight.
 * It is _not_ the relationship being compiled by this function, it's a relationship that uses JS variables, and we need compile
 * whatever generates those variables.
 */
function compileProducerOfNodeId(cc: CompilerCache, nodeId: NodeId, sourceRelationship: RelationshipData): CompiledLine[] {
  if (!cc.nav.isVar(nodeId)) {
    return compileLiteralAssignment(cc, nodeId);
  }

  const fnCallRelationships = cc.nav.nonSignatureRelationshipsFromOutputVarId(nodeId, sourceRelationship);
  const boolTrees = cc.lookupBoolTreesThatProducesVar(nodeId);

  if (fnCallRelationships.length > 0) {
    if (fnCallRelationships.length !== 1) {
      cc.nav.reportError(`Only one producer per variable is currently supported, found ${fnCallRelationships.length} for ${nodeId}`, sourceRelationship);
    }
    return compileFunctionCall(cc, fnCallRelationships[0] ?? throwIndexOutOfBounds());
  } else {
    if (boolTrees.length === 0) {
      const signatureOfCurrentFn = cc.inFn();
      const isParamOfCurrentFn = (
        signatureOfCurrentFn !== undefined &&
        cc.nav.getInputsAndOutputs(signatureOfCurrentFn).inputNodeIds.some(inputNodeId => {
          const inputValue = signatureOfCurrentFn.mapping[inputNodeId] ?? throwIndexOutOfBounds();
          return inputValue === nodeId;
        })
      );

      if (isParamOfCurrentFn) {
        return [];
      }

      cc.nav.reportError(`No relationships exist that produce the value ${nodeId}`, sourceRelationship);
    }
    return compileConditionalAssignments(cc, boolTrees);
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

  // Converts function definitions to statements first, so reorderCompiledLine() will put them in the correct order instead of keeping them set apart.
  // We're ready to combine the two types together at this point.
  // This isn't strictly necessary since JavaScript does function hoisting, but it does also force us to see that all free variables the functions depend
  // on are getting properly bound.
  const { globalLines, lines } = reorderCompiledLines(statements.map(statement => {
    if (statement.type === 'statement') {
      return statement;
    }

    return {
      type: 'statement',
      line: statement.content,
      varDependencies: statement.varDependencies,
      supplies: undefined,
    };
  }));
  return [
    globalLines.map(l => l.line).join('\n'),
    lines.join('\n'),
  ].join('\n\n');
}

export function bedrockToJs(bedrockData: BedrockData) {
  const nav = new BedrockNavigator(bedrockData);
  const cc = new CompilerCache(nav);

  const result = compileProgram(cc);

  return result;
}
