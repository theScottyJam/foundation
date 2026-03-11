export function assert(condition: boolean, message = 'Assertion failed'): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

/** Used when you wish to access an array element that you know must exist, and you need to tell TypeScript of this.
 * e.g. `myArray[0]?.sub.prop ?? throwIndexOutOfBounds()`
 */
export function throwIndexOutOfBounds(): never {
  throw new Error('Internal error: Attempted to index an array with an out-of-bounds index.');
}

export class UnreachableCaseError extends Error {
  constructor(value: never) {
    super('Unreachable');
  }
}
