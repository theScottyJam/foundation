import type { DeclarationBlockNode, ExpressionNode, FnNode, IdentifierNode } from './parser.ts';
import type { ReadyValue, Value, OnExecCtrl } from './runtime.ts';
import type { Position, Range } from './shared.ts';
import { assert } from './util.ts';

const builtinPos: Position = {
  index: 0,
  line: 1,
  col: 1,
};

const builtinRange: Range = {
  start: builtinPos,
  end: builtinPos,
};

/** Can be used as a sentinel, or to capture a value */
function createBasicFn(opts: { name?: string, returnValue?: ReadyValue | 'ERROR' }): ReadyValue {
  return {
    ready: true,
    id: Symbol(`builtin-fn:${opts.name ?? '<anonymous>'}`),
    capturedVars: new Map(),
    definition: {
      category: 'fn',
      defId: Symbol('builtin'),
      name: opts.name !== undefined ? `<builtin ${opts.name} fn>` : '<builtin fn>',
      fnRefName: undefined,
      param: asIdNode('x'),
      body: {
        category: 'internal',
        onExec: () => {
          if (opts.returnValue === undefined || opts.returnValue === 'ERROR') {
            throw new Error('This should not be called');
          }
          return opts.returnValue;
        },
        containedVarReferences: [asIdNode('x')],
      },
      range: builtinRange,
    },
  };
}

const createSentinel = (name: string) => createBasicFn({ name });

const asIdNode = (name: string): IdentifierNode => ({
  category: 'identifier',
  identifier: name,
  range: builtinRange,
});

function createBuiltinFn(
  name: string,
  params: string[],
  onExec: (ctrl: OnExecCtrl, ...paramNodes: IdentifierNode[]) => ReadyValue,
): FnNode {
  const rootExpression = {
    category: 'internal' as const,
    // This onExec function will get replaced soon, so it doesn't matter what it is set to
    onExec: (() => {}) as any,
    containedVarReferences: params.map(param => asIdNode(param)),
  };
  const paramNodes: IdentifierNode[] = [];
  let expression: FnNode['body'] = rootExpression;
  for (const param of [...params].reverse()) {
    expression = {
      category: 'fn',
      defId: Symbol(`<builtin ${name} partially applied>`),
      name: `<builtin ${name} partially applied>`,
      fnRefName: undefined,
      param: asIdNode(param),
      body: expression,
      range: builtinRange,
    } satisfies FnNode;
    paramNodes.unshift(expression.param);
  }

  rootExpression.onExec = (ctrl: OnExecCtrl) => onExec(ctrl, ...paramNodes);

  return {
    ...expression as FnNode,
    name: `<builtin ${name}>`,
  };
}

const call = (ctrl: OnExecCtrl, fn: ReadyValue, arg: Value) => ctrl.call({
  category: 'builtinFnCallNode',
  beingCalled: fn,
  arg,
  range: builtinRange,
});

const stdLibDef = {
  stdThrow: createBuiltinFn('stdThrow', ['n'], (ctrl: OnExecCtrl, $n) => {
    ctrl.throwRuntimeError('Runtime Error. stdThrow() was called.', builtinRange);
  }),
  stdLogNat: createBuiltinFn('stdLogNat', ['n'], (ctrl: OnExecCtrl, $n) => {
    const sentinel = createSentinel('reprNatComparisonSentinel');
    const natNumb = ctrl.evaluateVar($n);
    let value = natNumb;
    let counter = 0;
    const seen = new Set<ReadyValue>();
    while (true) {
      assert(
        !seen.has(value),
        'Going in a loop while trying to find the value of a number.',
      );
      seen.add(value);
      assert(
        counter <= 100,
        'Numeric value is greater than 100, or we got stuck in an infinite loop trying to evaluate a non-natural-number.',
      );

      const result = call(ctrl, value, sentinel);
      if (result === sentinel) {
        // This means zero, so break
        break;
      } else {
        // We have the previous number.
        value = result;
        counter++;
      }
    }

    console.info(counter);
    return natNumb;
  }),
} satisfies Record<string, FnNode>;

interface AttachStdLibOpts {
  readonly rootNode: ExpressionNode
  readonly fnRefNameToFnNode: Map<string, FnNode>
}

export const attachStdLib = ({ rootNode, fnRefNameToFnNode }: AttachStdLibOpts): DeclarationBlockNode => {
  const declarations = Object.entries(stdLibDef)
    .map(([name, bindValue]) => ({ identifier: asIdNode(name), bindValue }));

  for (const [fnRefName, fnNode] of fnRefNameToFnNode) {
    const fnCheckerName = `is#${fnRefName}`;
    declarations.push({
      identifier: asIdNode(fnCheckerName),
      bindValue: createFnNameRefCheckerFn(fnCheckerName, fnNode),
    });
  }

  return {
    category: 'declarationBlock',
    declarations,
    finalExpression: rootNode,
    range: builtinRange,
  };
};

function createFnNameRefCheckerFn(fnCheckerName: string, fnNode: FnNode): FnNode {
  return createBuiltinFn(fnCheckerName, ['value', 'isTrue', 'isFalse'], (ctrl: OnExecCtrl, $value, $ifTrue, $ifFalse) => {
    const value = ctrl.evaluateVar($value);
    if (value.definition.defId === fnNode.defId) {
      return ctrl.evaluateVar($ifTrue);
    } else {
      return ctrl.evaluateVar($ifFalse);
    }
  });
}
