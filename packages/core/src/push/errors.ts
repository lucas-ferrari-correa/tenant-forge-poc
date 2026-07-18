export type SchemaPushErrorCode =
  | 'TENANTS_REQUIRED'
  | 'INVALID_IDENTIFIER'
  | 'UNSUPPORTED_DIALECT'
  | 'UNSUPPORTED_FIELD'
  | 'EXECUTION_FAILED'
  | 'INVALID_OPTIONS'

export class SchemaPushError extends Error {
  readonly code: SchemaPushErrorCode

  constructor(code: SchemaPushErrorCode, message: string) {
    super(message)
    this.name = 'SchemaPushError'
    this.code = code
  }
}
