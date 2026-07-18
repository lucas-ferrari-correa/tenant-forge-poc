export type TenancyMigrateErrorCode =
  | 'TENANTS_REQUIRED'
  | 'UNSUPPORTED_TRANSITION'
  | 'VERIFY_FAILED'
  | 'EXECUTION_FAILED'
  | 'INVALID_OPTIONS'
  | 'SCHEMA_VALIDATION'
  | 'UNSUPPORTED_DIALECT'
  | 'ENTITY_MISSING'
  | 'AMBIGUOUS_SOURCE'

export class TenancyMigrateError extends Error {
  readonly code: TenancyMigrateErrorCode

  constructor(code: TenancyMigrateErrorCode, message: string) {
    super(message)
    this.name = 'TenancyMigrateError'
    this.code = code
  }
}
