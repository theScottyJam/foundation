export interface Position {
  readonly index: number
  readonly line: number
  readonly col: number
}

export interface Range {
  readonly start: Position
  readonly end: Position
}

export interface Token {
  readonly value: string
  readonly range: Range
}
