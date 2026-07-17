export type DslSourcePosition = {
  line: number
  column: number
  offset: number
}

export type DslParseErrorCode =
  | 'UNEXPECTED_TOKEN'
  | 'UNEXPECTED_EOF'
  | 'INVALID_TENANCY_MODEL'
  | 'INVALID_FIELD_TYPE'
  | 'INVALID_RELATION_KIND'
  | 'INVALID_DEFAULT'
  | 'INVALID_BINDING_SCOPE'
  | 'DUPLICATE_SCHEMA'
  | 'MISSING_SCHEMA'
  | 'MISSING_TENANCY'
  | 'INVALID_BLOCK'

export class DslParseError extends Error {
  readonly code: DslParseErrorCode
  readonly position: DslSourcePosition | undefined

  constructor(code: DslParseErrorCode, message: string, position?: DslSourcePosition) {
    const loc = position === undefined ? '' : ` at ${position.line}:${position.column}`
    super(`DSL parse error${loc}: ${message}`)
    this.name = 'DslParseError'
    this.code = code
    this.position = position
  }
}
