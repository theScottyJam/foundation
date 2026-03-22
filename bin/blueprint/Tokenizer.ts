import type { Position, Token } from './shared.ts';
import { assert, throwIndexOutOfBounds } from '../util.ts';

// EOF is represented by the empty string
export const EOF = '';

export const RESERVED_CHARS = ['(', ')', '{', '}', '=', ',', '.', ':', '-', '>'];

export class Tokenizer {
  text: string;
  index = 0;
  line = 1;
  col = 1;
  #tokens: Token[] = [];
  constructor(text: string) {
    this.text = text;
    this.#tokens.push(this.#extractNextToken());
  }

  peek(): Token {
    return this.#tokens[0] ?? throwIndexOutOfBounds();
  }

  next(): Token {
    const token = this.#tokens[0]!;
    this.#tokens.shift();
    this.#tokens.push(this.#extractNextToken());
    return token;
  }

  #extractNextToken(): Token {
    let start!: Position;
    let value = '';
    let skipWhitespace = true;
    let inLineComment = false;
    let inBlockComment = false;
    while (true) {
      if (skipWhitespace) {
        start = { index: this.index, line: this.line, col: this.col };
      }
      const char = this.text[this.index];
      if (char === undefined) {
        break;
      }
      const isWhitespace = /\s/.test(char);
      const isOneCharToken = RESERVED_CHARS.includes(char);
      const inComment = inLineComment || inBlockComment;
      if (isWhitespace && !skipWhitespace && !inComment) {
        break;
      }
      if (isOneCharToken && value !== '' && !inComment) {
        // More characters can't be added to this token, so break.
        break;
      }
      this.index++;
      this.col++;
      if (char === '\n') {
        this.line++;
        this.col = 1;
      }
      if (char === '/' && this.text[this.index] === '/' && skipWhitespace) {
        inLineComment = true;
        continue;
      }
      if (char === '/' && this.text[this.index] === '*' && skipWhitespace) {
        inBlockComment = true;
        continue;
      }
      if (char === '\n' && inLineComment) {
        inLineComment = false;
        continue;
      }
      if (this.text[this.index - 2] === '*' && char === '/' && inBlockComment) {
        inBlockComment = false;
        continue;
      }
      if (inComment) {
        continue;
      }
      if (isWhitespace && skipWhitespace) {
        continue;
      }
      if (!isWhitespace) {
        skipWhitespace = false;
      }
      value += char;
      if (isOneCharToken) {
        // `value` should have one character in it. Break so more can't be added.
        break;
      }
    }

    assert(!inBlockComment, 'Unterminated block comment');
    if (value === '') {
      assert(this.text[this.index] === undefined);
    }

    return {
      value,
      range: {
        start: start ?? throwIndexOutOfBounds(),
        end: { index: this.index, line: this.line, col: this.col },
      },
    };
  }
}
