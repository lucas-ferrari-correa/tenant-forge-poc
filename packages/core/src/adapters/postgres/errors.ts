export type PostgresAdapterErrorCode =
  | 'INVALID_IDENTIFIER'
  | 'UNSUPPORTED_ISOLATION'
  | 'MISSING_DATA'
  | 'EXECUTION_FAILED'

export class PostgresAdapterError extends Error {
  readonly code: PostgresAdapterErrorCode

  constructor(code: PostgresAdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'PostgresAdapterError'
    this.code = code
  }
}
