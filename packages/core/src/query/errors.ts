/**
 * Fail-closed errors for query IR construction (no adapter execution).
 */

export type QueryBuildErrorCode =
  | 'INVALID_OPERATION'
  | 'UNKNOWN_ENTITY'
  | 'INVALID_TENANT_CONTEXT'
  | 'UNTRUSTED_TENANT_AUTHORITY'
  | 'TENANCY_UNRESOLVABLE'
  | 'CLIENT_TENANT_ID_FORBIDDEN'

export class QueryBuildError extends Error {
  readonly code: QueryBuildErrorCode

  constructor(code: QueryBuildErrorCode, message: string) {
    super(message)
    this.name = 'QueryBuildError'
    this.code = code
  }
}
