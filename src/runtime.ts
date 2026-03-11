import { buildErrorWithUnderlinedText } from './errorFormatter.ts';
import type { BuiltinFnCallNode, ExpressionNode, FnCallNode, FnNode, IdentifierNode } from './parser.ts';
import type { SemanticCheckResults } from './semanticCheck.ts';
import type { Range } from './shared.ts';
import { assert, throwIndexOutOfBounds, UnreachableCaseError } from './util.ts';

export interface Thunk {
  readonly ready: false
  readonly capturedVars: Map<symbol, Value>
  readonly definition: ExpressionNode
  cachedResult?: ReadyValue
  /** Set to true if we're currently trying to figure out its value. Used to prevent cycles. */
  evaluating: boolean
}

export interface ReadyValue {
  readonly ready: true
  readonly id: symbol
  // Performance optimization: Technically the captured vars are unnecessary in a ReadyValue, as the thunk has already been evaluated.
  // (Unless I'm doing AST reflection, in which case I might need to reference it).
  readonly capturedVars: Map<symbol, Value>
  readonly definition: FnNode
}

export type Value = Thunk | ReadyValue;

interface StackFrame {
  /** Local and captured variables */
  readonly vars: Map<symbol, Value>
  readonly isThunk: boolean
  readonly fnName?: string
  readonly at: Range
  readonly ignoreInStackTrace?: true
}

interface RuntimeContext {
  readonly fileContents: string
  readonly stack: StackFrame[]
  readonly semanticResults: SemanticCheckResults
}

export interface OnExecCtrl {
  readonly evaluateVar: (identifierNode: IdentifierNode) => ReadyValue
  readonly call: (fnCallNode: BuiltinFnCallNode) => ReadyValue
  /** Look up the variable without auto-evaluating it. */
  readonly rawVarLookup: (identifierNode: IdentifierNode) => Value
  readonly throwRuntimeError: (message: string, range: Range) => never
}

export interface InternalBody {
  readonly category: 'internal'
  readonly onExec: (ctrl: OnExecCtrl) => ReadyValue
  // Identifier nodes of variables this function references from the outer scopes.
  // These aren't the identifier nodes of the variable declarations themselves, rather,
  // they're unique identifier nodes that are supposed to act like they were found inside the builtin function's body,
  // referencing the declarations.
  // These will typically contain identifier nodes for the function parameters of the built in function.
  readonly containedVarReferences: IdentifierNode[]
}

export function run(rootNode: ExpressionNode, semanticResults: SemanticCheckResults, fileContents: string) {
  const ctx: RuntimeContext = {
    fileContents,
    semanticResults,
    stack: [{
      vars: new Map(),
      isThunk: true,
      at: {
        start: { line: 1, col: 1, index: 0 },
        end: { line: 1, col: 1, index: 0 },
      },
    }],
  };

  return evaluate(ctx, rootNode);
}

function evaluate(ctx: RuntimeContext, node: ExpressionNode): ReadyValue {
  if (node.category === 'identifier') {
    return lookupAndEvaluateVar(ctx, node);
  }

  if (node.category === 'fn') {
    return {
      ready: true,
      id: Symbol(`fn:${node.name}`),
      capturedVars: captureVars(ctx, node),
      definition: node,
    };
  }

  if (node.category === 'fnCallNode') {
    return callFn(ctx, node);
  }

  if (node.category === 'declarationBlock') {
    const varsInScope = captureVars(ctx, node);
    for (const { identifier, bindValue } of node.declarations) {
      const binding: Value = {
        ready: false,
        capturedVars: varsInScope,
        definition: bindValue,
        evaluating: false,
      };
      varsInScope.set(varIdFromIdentifierNode(ctx, identifier), binding);
    }

    const newCtx: RuntimeContext = {
      ...ctx,
      stack: [
        ...ctx.stack,
        {
          vars: varsInScope,
          isThunk: true,
          at: node.finalExpression.range,
          // Ignoring, because we're not jumping to a thunk when evaluating this
          ignoreInStackTrace: true,
        },
      ],
    };

    return evaluate(newCtx, node.finalExpression);
  }

  throw new UnreachableCaseError(node);
}

function callFn(ctx: RuntimeContext, node: FnCallNode | BuiltinFnCallNode): ReadyValue {
  let fn: ReadyValue;
  let arg: Value;
  if (node.category === 'builtinFnCallNode') {
    fn = node.beingCalled;
    arg = node.arg;
  } else {
    fn = evaluate(ctx, node.beingCalled);
    arg = {
      ready: false,
      capturedVars: captureVars(ctx, node),
      definition: node.arg,
      evaluating: false,
    };
  }

  const newBindings = new Map<symbol, Value>();
  newBindings.set(varIdFromIdentifierNode(ctx, fn.definition.param), arg);

  const newCtx: RuntimeContext = {
    ...ctx,
    stack: [
      ...ctx.stack,
      {
        vars: new Map([
          ...fn.capturedVars,
          ...newBindings,
        ]),
        fnName: fn.definition.name,
        isThunk: false,
        at: fn.definition.range,
      },
    ],
  };

  if (fn.definition.body.category === 'internal') {
    return fn.definition.body.onExec({
      evaluateVar: (identifierNode: IdentifierNode) => {
        return lookupAndEvaluateVar(newCtx, identifierNode);
      },
      call: (fnCallNode: BuiltinFnCallNode) => {
        return callFn(newCtx, fnCallNode);
      },
      rawVarLookup: (identifierNode: IdentifierNode) => {
        const value = ctx.stack.at(-1)!.vars.get(varIdFromIdentifierNode(ctx, identifierNode));
        assert(value !== undefined);
        return value;
      },
      throwRuntimeError: (message: string, range: Range) => {
        throw new RuntimeError(ctx, message, range);
      },
    });
  } else {
    return evaluate(newCtx, fn.definition.body);
  }
}

/** Captures variables that are in scope to help create a closure or thunk. */
function captureVars(ctx: RuntimeContext, forNode: ExpressionNode): Map<symbol, Value> {
  const varsToCapture = ctx.semanticResults.nodeToCapturedVars.get(forNode);
  assert(varsToCapture !== undefined, 'Failed to find the set of variables to capture.');

  const topStackEntry = ctx.stack.at(-1)?.vars ?? throwIndexOutOfBounds();
  const varIdToValue = new Map<symbol, Value>();
  for (const varId of varsToCapture) {
    varIdToValue.set(varId, topStackEntry.get(varId) ?? throwIndexOutOfBounds());
  }

  // Alternatively, this implementation for captureVars() works as well. It just captures everything.
  // If things ever get buggy with how it tries to capture variables, this could be used instead.
  // return new Map(ctx.stack.at(-1)?.vars ?? throwIndexOutOfBounds());
  return varIdToValue;
}

function lookupAndEvaluateVar(ctx: RuntimeContext, identifierNode: IdentifierNode): ReadyValue {
  const value = ctx.stack.at(-1)!.vars.get(varIdFromIdentifierNode(ctx, identifierNode));
  if (value === undefined) {
    throw new RuntimeError(ctx, `Failed to find var "${identifierNode.identifier}"`, identifierNode.range);
  }
  assert(value !== undefined, `Failed to find the variable "${identifierNode.identifier}". (Did we fail to capture it in a closure correctly?)`);

  if (value.ready) {
    return value;
  }
  if (value.evaluating) {
    throw new RuntimeError(ctx, `Cycle detected when attempting to lookup variable "${identifierNode.identifier}".`, identifierNode.range);
  }
  if (value.cachedResult !== undefined) {
    return value.cachedResult;
  }

  const newCtx = {
    ...ctx,
    stack: [
      ...ctx.stack,
      {
        vars: value.capturedVars,
        isThunk: true,
        at: value.definition.range,
      },
    ],
  };

  value.evaluating = true;
  const result = evaluate(newCtx, value.definition);
  value.evaluating = false;
  value.cachedResult = result;
  return result;
}

function varIdFromIdentifierNode(ctx: RuntimeContext, identifierNode: IdentifierNode): symbol {
  const varId = ctx.semanticResults.identifierNodeToVarId.get(identifierNode);
  assert(varId !== undefined);
  return varId;
}

export class RuntimeError extends Error {
  constructor(ctx: RuntimeContext, message: string, range: Range) {
    const frameDetails = [
      buildErrorWithUnderlinedText(message, {
        fileContents: ctx.fileContents,
        start: range.start.index,
        end: range.end.index,
      }),
    ];
    // Skips the root frame
    for (const frame of [...ctx.stack].slice(1).reverse()) {
      if (frame.ignoreInStackTrace) {
        continue;
      }

      if (frame.isThunk) {
        frameDetails.push(`    at ${frame.at.start.line}:${frame.at.start.col}-${frame.at.end.line}:${frame.at.end.col}`);
      } else {
        frameDetails.push(`  at ${frame.fnName ?? 'anonymous'} ${frame.at.start.line}:${frame.at.start.col}`);
      }
    }

    super(frameDetails.join('\n'));
  }
}
