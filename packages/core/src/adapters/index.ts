export {
  type CreatePostgresAdapterOptions,
  compileQueryIr,
  createPostgresAdapter,
  type PostgresAdapter,
  PostgresAdapterError,
  type PostgresAdapterErrorCode,
  type PostgresExecuteResult,
  type PostgresRow,
  quoteIdent,
  type SqlStatement,
} from './postgres/index.js'
