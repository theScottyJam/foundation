/*
 * This module and its dependencies are copied from the
 * https://github.com/theScottyJam/moat-maker/blob/76ab5c39f22c370e1722ef38fe5c0f8890b86317/src/ruleParser/TextPosition.ts
 * project with minimal modifications.
 * This module technically supports capabilities that this project doesn't need due to where it came from.
 *
 * The buildErrorWithUnderlinedText() function was added as a higher-level API for the rest of this module.
 */

// Note that sometimes this module uses the term "char" loosely,
// and may call strings like "${…}" or "\\n" a "char".

const MAX_LINE_WIDTH = 70;
const MAX_UNDERLINED_WIDTH = 40;

interface TextParts {
  readonly displaysBeforeUnderline: StringArray
  readonly underlined: StringArray
  readonly displaysAfterUnderline: StringArray
}

/**
 * @param message the error message
 * @param fileContents The source text.
 * @param start Where in {@link fileContents} the issue started at
 * @param end Where in {@link fileContents} the issue ended at
 */
export function buildErrorWithUnderlinedText(message: string, opts: { fileContents: string, start: number, end: number }): string {
  const { fileContents, start: startIndex, end: endIndex } = opts;
  const startOfFilePos = TextPosition.atStartPos([fileContents]);
  const start = startOfFilePos.advance(startIndex);
  const end = start.advance(endIndex - startIndex);
  return generateMessageWithPosition(message, [fileContents], { start, end });
};

function generateMessageWithPosition(message: string, text: readonly string[], range: TextRange): string {
  const startOfFirstErrorLine = findBeginningOfLine(text, range.start);
  const endOfLastErrorLine = findEndOfLine(range.end);
  const asStringArray = (text: string[]): StringArray => new StringArray(text);

  const textBeingDisplayedParts = {
    displaysBeforeUnderline: pipe(
      TextPosition.getSlice(startOfFirstErrorLine, range.start),
      removeLeadingWhitespace,
      replaceSpecialChars,
      asStringArray,
    ),
    underlined: pipe(
      TextPosition.getSlice(range.start, range.end),
      replaceSpecialChars,
      asStringArray,
    ),
    displaysAfterUnderline: pipe(
      TextPosition.getSlice(range.end, endOfLastErrorLine),
      replaceSpecialChars,
      asStringArray,
    ),
  };

  const underlinedText = pipe(
    textBeingDisplayedParts,
    truncateUnderlinedPortionIfTooLarge,
    (parts) => (attemptToFitEverythingUsingOnlyARightTruncate(parts) ?? truncateOnBothEnds(parts)),
    renderUnderlinedText,
  );

  return [
    `${message} (line ${range.start.lineNumb}, col ${range.start.colNumb})`,
    indentMultilineString(underlinedText, 2),
  ].join('\n');
}

const replaceSpecialChars = (text: readonly ContentPointedAt[]): readonly string[] => {
  return text.map(char => {
    if (char === '\n') return '\\n';
    if (char === INTERPOLATION_POINT) return '${…}';
    return char;
  });
};

function removeLeadingWhitespace(text: readonly ContentPointedAt[]): readonly ContentPointedAt[] {
  const notWhitespaceIndex = text.findIndex(char => typeof char !== 'string' || /^\s$/.exec(char) === null);
  return text.slice(notWhitespaceIndex);
}

/**
 * If the underlined portion crosses a threshold, its center will be replaced with a "…".
 */
function truncateUnderlinedPortionIfTooLarge(parts: TextParts): TextParts {
  if (parts.underlined.contentLength <= MAX_UNDERLINED_WIDTH) {
    return parts;
  }

  const center = '…';
  const left = new StringArray(parts.underlined.array);
  const rightReversed = new StringArray();

  // Moves content so there's an even amount of content in both arrays.
  while (left.contentLength > rightReversed.contentLength) {
    rightReversed.push(left.pop()!);
  }

  while (left.contentLength + center.length + rightReversed.contentLength > MAX_UNDERLINED_WIDTH) {
    popFromSmallest(left, rightReversed);
  }

  return {
    ...parts,
    underlined: new StringArray([...left.array, center, ...rightReversed.reversed().array]),
  };
}

/**
 * Attempts to keep the text within a max size limit by only truncating on the right side, if needed.
 * If The truncation would cause part of the underlined portion to be lost, then this will fail and return null.
 * pre-condition: The underlined must already be truncated if it was too large.
 */
function attemptToFitEverythingUsingOnlyARightTruncate(parts: TextParts): TextParts | null {
  const mustBeVisible = parts.displaysBeforeUnderline.contentLength + parts.underlined.contentLength;
  if (mustBeVisible >= MAX_LINE_WIDTH) {
    return null;
  }

  const newAfterUnderline: StringArray = new StringArray();
  const etcChar = '…';
  for (const char of parts.displaysAfterUnderline.array) {
    if (mustBeVisible + newAfterUnderline.contentLength + etcChar.length + char.length > MAX_LINE_WIDTH) {
      newAfterUnderline.push(etcChar);
      break;
    }
    newAfterUnderline.push(char);
  }

  return {
    ...parts,
    displaysAfterUnderline: newAfterUnderline,
  };
}

/**
 * Centers the underlined portion and truncate the text on both ends.
 * pre-condition: The underlined must already be truncated if it was too large.
 */
function truncateOnBothEnds(parts: TextParts): TextParts {
  const newBeforeUnderlineReversed = parts.displaysBeforeUnderline.reversed();
  const newAfterUnderline = new StringArray(parts.displaysAfterUnderline.array);
  while (newBeforeUnderlineReversed.contentLength + parts.underlined.contentLength + newAfterUnderline.contentLength > MAX_LINE_WIDTH) {
    popFromSmallest(newBeforeUnderlineReversed, newAfterUnderline);
  }

  newBeforeUnderlineReversed.pop();
  newBeforeUnderlineReversed.push('…');
  if (newAfterUnderline.contentLength !== parts.displaysAfterUnderline.contentLength) {
    newAfterUnderline.pop();
    newAfterUnderline.push('…');
  }

  return {
    displaysBeforeUnderline: newBeforeUnderlineReversed.reversed(),
    underlined: parts.underlined,
    displaysAfterUnderline: newAfterUnderline,
  };
}

/**
 * Converts a given line of code and underline position information into a single string
 * with the underline drawn in the correct location under the provided line.
 */
function renderUnderlinedText(parts: TextParts): string {
  const leftOfUnderlined = parts.displaysBeforeUnderline.array.join('');
  const underlined = parts.underlined.array.join('');
  const rightOfUnderlined = parts.displaysAfterUnderline.array.join('');
  return [
    (leftOfUnderlined + underlined + rightOfUnderlined).trimEnd(),
    ' '.repeat(leftOfUnderlined.length) + '~'.repeat(Math.max(underlined.length, 1)),
  ].join('\n');
}

function findBeginningOfLine(text: readonly string[], startPos: TextPosition): TextPosition {
  let pos = startPos;
  while (true) {
    if (pos.atStartOfText() || pos.getPreviousChar() === '\n') {
      return pos;
    }
    pos = pos.backtrackInLine(1);
  }
}

function findEndOfLine(startPos: TextPosition): TextPosition {
  for (const pos of startPos.iterForwards()) {
    const char = pos.getChar();
    if (char === '\n' || char === END_OF_TEXT) {
      return pos;
    }
  }

  assert(false);
}

/**
 * Pops from the smallest of the two string-arrays, preferring the second argument
 * if they're the same size.
 */
function popFromSmallest(stringArray1: StringArray, stringArray2: StringArray): void {
  let popped;
  if (stringArray1.contentLength >= stringArray2.contentLength) {
    popped = stringArray1.pop();
  } else {
    popped = stringArray2.pop();
  }
  assert(popped !== undefined);
}

/**
 * Helper class that helps keep the array and the length of its combined content in sync.
 */
class StringArray {
  #array;
  #contentLength;
  constructor(content: string[] = []) {
    this.#array = [...content];
    this.#contentLength = content.join('').length;
  }

  get array(): string[] {
    return this.#array;
  }

  get contentLength(): number {
    return this.#contentLength;
  }

  push(value: string): void {
    this.#array.push(value);
    this.#contentLength += value.length;
  }

  pop(): string | undefined {
    const value = this.#array.pop();
    this.#contentLength -= value?.length ?? 0;
    return value;
  }

  /** Returns a reversed copy. */
  reversed(): StringArray {
    return new StringArray([...this.#array].reverse());
  }
}

interface TextPositionData {
  readonly sectionIndex: number
  readonly textIndex: number
  readonly lineNumb: number
  readonly colNumb: number
}

interface TextRange {
  readonly start: TextPosition
  readonly end: TextPosition
}

/**
 * A TextPosition generally points at a character, but it can point after the
 * end of a section. This is intended to represent "pointing at an interpolation point",
 * and anything fetching the character it points to might receive this if the textPosition
 * is in this state.
 */
const INTERPOLATION_POINT = Symbol('interpolation point');

/**
 * A TextPosition generally points at a character, but it can point after the
 * end of the last section. This is intended to represent "pointing at the end of the text",
 * and anything fetching the character it points to might receive this if the textPosition
 * is in this state.
 */
const END_OF_TEXT = Symbol('end of text');

/** Represents something that a textPosition might be pointing at. */
type PointedAt = string | typeof INTERPOLATION_POINT | typeof END_OF_TEXT;

/** Same as `PointedAt`, except without the end-of-text symbol. */
type ContentPointedAt = string | typeof INTERPOLATION_POINT;

class TextPosition {
  readonly #sections: readonly string[];
  readonly sectionIndex: number;
  readonly textIndex: number;
  // These are 1-based
  readonly lineNumb: number;
  readonly colNumb: number;

  constructor(sections: readonly string[], posData: TextPositionData) {
    this.#sections = sections;
    this.sectionIndex = posData.sectionIndex;
    this.textIndex = posData.textIndex;
    // These are 1-based
    this.lineNumb = posData.lineNumb;
    this.colNumb = posData.colNumb;
    Object.freeze(this);
  }

  static atStartPos(sections: readonly string[]): TextPosition {
    return new TextPosition(sections, {
      sectionIndex: 0,
      textIndex: 0,
      lineNumb: 1,
      colNumb: 1,
    });
  }

  getChar(): PointedAt {
    return this.#getCharAt(this);
  }

  getPreviousChar(): PointedAt {
    if (this.textIndex === 0) {
      assert(this.sectionIndex !== 0, 'Reached beginning of text');
      return this.#getCharAt({
        sectionIndex: this.sectionIndex - 1,
        textIndex: this.#sections[this.sectionIndex - 1]?.length ?? throwIndexOutOfBounds(),
      });
    } else {
      return this.#getCharAt({
        textIndex: this.textIndex - 1,
        sectionIndex: this.sectionIndex,
      });
    }
  }

  #getCharAt({ textIndex, sectionIndex }: { textIndex: number, sectionIndex: number }): PointedAt {
    const isLastSection = sectionIndex === this.#sections.length - 1;
    const endOfSection = textIndex >= (this.#sections[sectionIndex]?.length ?? throwIndexOutOfBounds());

    if (isLastSection && endOfSection) return END_OF_TEXT;
    if (endOfSection) return INTERPOLATION_POINT;
    return this.#sections[sectionIndex]?.[textIndex] ?? throwIndexOutOfBounds();
  }

  /**
   * Move the textPosition instance forwards by the provided amount.
   * This is an O(n) operation (where `n` is the value of amount)
   */
  advance(amount: number): TextPosition {
    let currentPos = this as TextPosition;
    for (let i = 0; i < amount; ++i) {
      currentPos = currentPos.#advanceOneUnit();
    }
    return currentPos;
  }

  #advanceOneUnit() {
    if (this.textIndex === (this.#sections[this.sectionIndex]?.length ?? throwIndexOutOfBounds())) {
      // advance to next section
      assert(this.sectionIndex + 1 !== this.#sections.length, 'Reached end of text');
      return new TextPosition(this.#sections, {
        sectionIndex: this.sectionIndex + 1,
        textIndex: 0,
        lineNumb: this.lineNumb,
        colNumb: this.colNumb,
      });
    } else {
      // advance within the current section
      let lineNumb = this.lineNumb;
      let colNumb = this.colNumb;
      const c = this.#sections[this.sectionIndex]?.[this.textIndex] ?? throwIndexOutOfBounds();
      if (c === '\n') {
        lineNumb++;
        colNumb = 1;
      } else {
        colNumb++;
      }

      return new TextPosition(this.#sections, {
        sectionIndex: this.sectionIndex,
        textIndex: this.textIndex + 1,
        lineNumb,
        colNumb,
      });
    }
  }

  /** Moves forward through the text, yielding each position, one at a time. */
  * iterForwards(): Generator<TextPosition> {
    let currentPos = this as TextPosition;
    while (true) {
      yield currentPos;
      if (currentPos.getChar() === END_OF_TEXT) {
        break;
      }
      currentPos = currentPos.advance(1);
    }
  }

  /**
   * Move the textPosition instance backwards by the provided amount.
   * This is an O(n) operation (where `n` is the value of amount)
   */
  backtrackInLine(amount: number): TextPosition {
    let currentPos = this as TextPosition;
    for (let i = 0; i < amount; ++i) {
      currentPos = currentPos.#backtrackOneUnitInLine();
    }
    return currentPos;
  }

  #backtrackOneUnitInLine(): TextPosition {
    if (this.textIndex === 0) {
      // backtrack to previous section
      assert(this.sectionIndex > 0, 'Reached beginning of text');
      return new TextPosition(this.#sections, {
        sectionIndex: this.sectionIndex - 1,
        textIndex: this.#sections[this.sectionIndex - 1]?.length ?? throwIndexOutOfBounds(),
        lineNumb: this.lineNumb,
        colNumb: this.colNumb,
      });
    } else {
      // backtrack within current section
      const c = this.#sections[this.sectionIndex]?.[this.textIndex - 1] ?? throwIndexOutOfBounds();
      assert(c !== '\n', 'Attempted to backtrack a text-position across a new line.');

      return new TextPosition(this.#sections, {
        sectionIndex: this.sectionIndex,
        textIndex: this.textIndex - 1,
        lineNumb: this.lineNumb,
        colNumb: this.colNumb - 1,
      });
    }
  }

  static getSlice(start: TextPosition, end: TextPosition): readonly ContentPointedAt[] {
    const result = [];
    for (const pos of start.iterForwards()) {
      if (pos.#equals(end)) {
        break;
      }

      const char = pos.getChar();
      assert(char !== END_OF_TEXT, 'Reached end-of-text without hitting the end pos.');
      result.push(char);
    }
    return result;
  }

  atStartOfText(): boolean {
    return this.sectionIndex === 0 && this.textIndex === 0;
  }

  #equals(other: TextPosition): boolean {
    return this.sectionIndex === other.sectionIndex && this.textIndex === other.textIndex;
  }
}

// ~~~ UTILS ~~~

function assert(condition: boolean, message = 'Assertion Failed'): asserts condition {
  if (!condition) {
    throw new Error('Internal Error: ' + message);
  }
}

function indentMultilineString(multilineString: string, amount: number): string {
  return multilineString.split('\n').map(line => ' '.repeat(amount) + line).join('\n');
}

// This TypeScript pipe() definition comes from https://dev.to/ecyrbe/how-to-use-advanced-typescript-to-define-a-pipe-function-381h
// One day, JavaScript/TypeScript will have a native pipe operator, at which point we can remove this
// mess and use that instead.

type AnyFunc = (...arg: any) => any;

type PipeArgs<F extends AnyFunc[], Acc extends AnyFunc[] = []> = F extends [
  (...args: infer A) => infer B,
]
  ? [...Acc, (...args: A) => B]
  : F extends [(...args: infer A) => any, ...infer Tail]
    ? Tail extends [(arg: infer B) => any, ...any[]]
      ? PipeArgs<Tail, [...Acc, (...args: A) => B]>
      : Acc
    : Acc;

type LastFnReturnType<F extends AnyFunc[], Else = never> = F extends [
  ...any[],
  (...arg: any) => infer R,
] ? R : Else;

function pipe<FirstFn extends AnyFunc, F extends AnyFunc[]>(
  arg: Parameters<FirstFn>[0],
  firstFn: FirstFn,
  ...fns: PipeArgs<F> extends F ? F : PipeArgs<F>
): LastFnReturnType<F, ReturnType<FirstFn>> {
  return (fns as AnyFunc[]).reduce((acc, fn) => fn(acc), firstFn(arg));
}

/** Used when you wish to access an array element that you know must exist, and you need to tell TypeScript of this.
 * e.g. `myArray[0]?.sub.prop ?? throwIndexOutOfBounds()`
 */
function throwIndexOutOfBounds(): never {
  throw new Error('Internal error: Attempted to index an array with an out-of-bounds index.');
}
