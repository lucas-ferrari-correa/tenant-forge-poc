export type MysqlAdapterErrorCode =
  | 'INVALID_IDENTIFIER'
  | 'UNSUPPORTED_ISOLATION'
  | 'MISSING_DATA'
  | 'EXECUTION_FAILED'

export class MysqlAdapterError extends Error {
  readonly code: MysqlAdapterErrorCode

  constructor(code: MysqlAdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'MysqlAdapterError'
    this.code = code
  }
}
