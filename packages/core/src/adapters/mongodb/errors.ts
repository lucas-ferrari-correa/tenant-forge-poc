export type MongodbAdapterErrorCode =
  | 'INVALID_IDENTIFIER'
  | 'UNSUPPORTED_ISOLATION'
  | 'MISSING_DATA'
  | 'EXECUTION_FAILED'

export class MongodbAdapterError extends Error {
  readonly code: MongodbAdapterErrorCode

  constructor(code: MongodbAdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'MongodbAdapterError'
    this.code = code
  }
}
