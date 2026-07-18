export type SchemaPullErrorCode =
  | 'AMBIGUOUS_TENANCY'
  | 'INVALID_IDENTIFIER'
  | 'UNSUPPORTED_DIALECT'
  | 'EXECUTION_FAILED'
  | 'INVALID_OPTIONS'
  | 'SCHEMA_VALIDATION'

export class SchemaPullError extends Error {
  readonly code: SchemaPullErrorCode

  constructor(code: SchemaPullErrorCode, message: string) {
    super(message)
    this.name = 'SchemaPullError'
    this.code = code
  }
}
