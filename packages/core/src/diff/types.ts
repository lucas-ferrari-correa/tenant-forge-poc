import type { SchemaAst } from '../ast/types.js'
import type {
  SchemaPullDialect,
  SchemaPullOptions,
  SchemaPullResult,
  SchemaPullTarget,
} from '../pull/types.js'

export type SchemaDiffChangeKind = 'localOnly' | 'remoteOnly' | 'mismatch'

/**
 * Descriptive path into the schema tree (dot-separated).
 * Examples: `entities.Task`, `entities.Task.fields.title.type`, `schema.tenancy.model`.
 */
export type SchemaDiffPath = string

export type SchemaDiffChange = {
  kind: SchemaDiffChangeKind
  path: SchemaDiffPath
  /** Present for localOnly / mismatch. */
  local?: unknown
  /** Present for remoteOnly / mismatch. */
  remote?: unknown
}

export type SchemaDiffOptions = {
  /**
   * Ignore `schema.name` when comparing (pull defaults to `pulled`).
   * Default: true.
   */
  ignoreSchemaName?: boolean
  /**
   * Skip `services` comparison (services are not introspected by pull).
   * Default: false — compare when present; AgainstDb may set true.
   */
  ignoreServices?: boolean
}

export type SchemaDiffAgainstDbOptions = SchemaDiffOptions & {
  /** Forwarded to `pullSchema`. */
  pull?: SchemaPullOptions
}

export type SchemaDiffResult = {
  /** True when `changes.length === 0` after ignore filters. */
  equal: boolean
  changes: SchemaDiffChange[]
  warnings: string[]
  /** Set when diffing against a live DB. */
  dialect?: SchemaPullDialect
  /** Pull snapshot when using `diffSchemaAgainstDb`. */
  pull?: SchemaPullResult
}

export type { SchemaAst, SchemaPullOptions, SchemaPullResult, SchemaPullTarget }
