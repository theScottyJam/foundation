export interface Position {
  readonly index: number
  readonly line: number
  readonly col: number
}

export interface Range {
  readonly start: Position
  readonly end: Position
}

export interface RelationshipData {
  readonly type: string
  readonly mapping: Record<string, string>
  readonly range: Range
}

export interface BedrockData {
  readonly sourceText: string
  readonly relationships: RelationshipData[]
  readonly links: Record<string, string>
}
