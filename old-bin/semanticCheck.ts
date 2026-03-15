import { buildErrorWithUnderlinedText } from './errorFormatter.ts';
import type { ExpressionNode, FnNode, IdentifierNode } from './parser.ts';
import type { Range } from './shared.ts';
import { throwIndexOutOfBounds, UnreachableCaseError } from './util.ts';

interface StackEntry {
  /** Maps variable names to unique ids */
  readonly declarations: Map<string, symbol>
  /** What needs to be captured for this closure/thunk */
  readonly varsToCapture: Set<symbol>
}

export interface SemanticCheckResults {
  readonly identifierNodeToVarId: WeakMap<IdentifierNode, symbol>
  readonly nodeToCapturedVars: WeakMap<ExpressionNode, symbol[]>
  readonly fnNameRefToFnDef: Map<string, FnNode>
}

/** Data in this context object can be mutated at any point. */
interface SemanticContext extends SemanticCheckResults {
  readonly reportError: (message: string, range: Range) => never
  stack: StackEntry[]
}

export class SemanticError extends Error {}

export function checkSemantics(astNode: ExpressionNode, fileContents: string): SemanticCheckResults {
  const ctx: SemanticContext = {
    reportError: (message: string, range: Range) => {
      throw new SemanticError(buildErrorWithUnderlinedText(message, {
        fileContents,
        start: range.start.index,
        end: range.end.index,
      }));
    },
    stack: [],
    identifierNodeToVarId: new WeakMap(),
    nodeToCapturedVars: new WeakMap(),
    fnNameRefToFnDef: new Map(),
  };

  checkSemantics_(ctx, astNode);

  return {
    identifierNodeToVarId: ctx.identifierNodeToVarId,
    nodeToCapturedVars: ctx.nodeToCapturedVars,
    fnNameRefToFnDef: ctx.fnNameRefToFnDef,
  };
}

function checkSemantics_(ctx: SemanticContext, astNode: ExpressionNode) {
  if (astNode.category === 'fn') {
    const newDeclarations: StackEntry['declarations'] = new Map();
    newDeclarations.set(
      astNode.param.identifier,
      varIdFromDeclaringIdentifierNode(ctx, astNode.param),
    );

    const varsToCapture = new Set<symbol>(); // Will be mutated
    const stackSnapshot = [...ctx.stack];
    ctx.stack.push({
      declarations: newDeclarations,
      varsToCapture,
    });

    if (astNode.body.category !== 'internal') {
      checkSemantics_(ctx, astNode.body);
    } else {
      for (const identifierNode of astNode.body.containedVarReferences) {
        checkSemantics_(ctx, identifierNode);
      }
    }
    ctx.stack = stackSnapshot;
    ctx.nodeToCapturedVars.set(astNode, [...varsToCapture]);
  } else if (astNode.category === 'fnCallNode') {
    const varsToCapture = new Set<symbol>(); // Will be mutated
    ctx.stack.push({
      // No new declarations are introduced
      declarations: new Map(),
      // But we still want to capture variables in case this is a thunk.
      varsToCapture,
    });
    checkSemantics_(ctx, astNode.beingCalled);
    checkSemantics_(ctx, astNode.arg);
    ctx.nodeToCapturedVars.set(astNode, [...varsToCapture]);
  } else if (astNode.category === 'identifier') {
    let varId: symbol;

    // Find where this variable gets declared
    let i = ctx.stack.length;
    while (true) {
      i--;
      if (i < 0) {
        ctx.reportError(`Variable with name "${astNode.identifier}" not found.`, astNode.range);
      }
      const varId_ = ctx.stack[i]!.declarations.get(astNode.identifier);
      if (varId_ !== undefined) {
        varId = varId_;
        break;
      }
    }

    // Associate this node with the found variable id
    ctx.identifierNodeToVarId.set(astNode, varId); // < -- Shouldn't be needed - it's not a "declaring" identifier node.

    // Record in every intermediate function that this variable needs to be captured in the closure.
    while (true) {
      i++;
      const fnDefStackEntry = ctx.stack[i];
      if (fnDefStackEntry === undefined) {
        break;
      }
      fnDefStackEntry.varsToCapture.add(varId);
    }

    // We only need to capture one variable ID for an identifier node - the variable id of that identifier node.
    ctx.nodeToCapturedVars.set(astNode, [varId]);
  } else if (astNode.category === 'declarationBlock') {
    // TODO: Support TDZ checking

    const newDeclarations: StackEntry['declarations'] = new Map();
    for (const { identifier } of astNode.declarations) {
      newDeclarations.set(
        identifier.identifier,
        varIdFromDeclaringIdentifierNode(ctx, identifier),
      );
    }

    const varsToCapture = new Set<symbol>(); // Will be mutated
    const stackSnapshot = [...ctx.stack];
    ctx.stack.push({
      declarations: newDeclarations,
      varsToCapture,
    });

    for (const { bindValue } of astNode.declarations) {
      checkSemantics_(ctx, bindValue);
    }
    checkSemantics_(ctx, astNode.finalExpression);
    ctx.stack = stackSnapshot;
    ctx.nodeToCapturedVars.set(astNode, [...varsToCapture]);
  } else {
    throw new UnreachableCaseError(astNode);
  }
}

/**
 * Registers and returns a variable id for an identifier node.
 * Should only be called on identifier nodes that are being used to declare the variable.
 */
function varIdFromDeclaringIdentifierNode(ctx: SemanticContext, identifierNode: IdentifierNode) {
  let varId = ctx.identifierNodeToVarId.get(identifierNode);
  if (varId !== undefined) {
    return varId;
  }

  varId = Symbol('var:' + identifierNode.identifier);
  ctx.identifierNodeToVarId.set(identifierNode, varId);
  return varId;
}
