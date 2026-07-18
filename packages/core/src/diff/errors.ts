export type SchemaDiffErrorCode = 'SCHEMA_VALIDATION' | 'INVALID_OPTIONS' | 'EXECUTION_FAILED'

export class SchemaDiffError extends Error {
  readonly code: SchemaDiffErrorCode

  constructor(code: SchemaDiffErrorCode, message: string) {
    super(message)
    this.name = 'SchemaDiffError'
    this.code = code
  }
}
