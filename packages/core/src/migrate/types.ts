import type { ConcreteTenancyModel } from '../ast/tenancy.js'
import type { SchemaAst } from '../ast/types.js'
import type { SchemaPullOptions } from '../pull/types.js'

export type TenancyMigrateDialect = 'postgres' | 'mysql' | 'mongodb'

export type TenancyMigrateTarget = {
  dialect: TenancyMigrateDialect
  connectionString: string
}

/**
 * Options for tenancy architecture migration (best-effort POC).
 * `tenants` is always required — used for data move, verify, and canary.
 */
export type TenancyMigrateOptions = {
  /** Tenant ids participating in the migration (`tenant_${slug}` namespaces). */
  tenants: readonly string[]
  /**
   * Explicit source SchemaAst (tenancy layout of the live DB).
   * When omitted, source is inferred via `pullSchema` (+ `pull` hints).
   */
  from?: SchemaAst
  /** Drop source objects after successful verify (default: true). */
  dropSource?: boolean
  /** Hints forwarded to `pullSchema` when `from` is omitted (MySQL/Mongo ambiguity). */
  pull?: SchemaPullOptions
  /** Postgres RLS GUC (default: app.current_tenant_id). */
  rlsSessionVar?: string
}

export type EntityMigrateAction = 'migrate' | 'noop' | 'copy-global'

export type EntityMigrateStep = {
  entity: string
  from: ConcreteTenancyModel | 'global'
  to: ConcreteTenancyModel | 'global'
  action: EntityMigrateAction
}

export type TenancyMigratePlan = {
  sourceAst: SchemaAst
  targetAst: SchemaAst
  tenants: readonly string[]
  steps: EntityMigrateStep[]
  dropSource: boolean
  rlsSessionVar: string
}

export type TenancyMigratedRow = {
  entity: string
  /** Absent for global copy. */
  tenant?: string
  rows: number
  skipped?: boolean
}

export type TenancyMigrateResult = {
  dialect: TenancyMigrateDialect
  steps: EntityMigrateStep[]
  migrated: TenancyMigratedRow[]
  warnings: string[]
}

/** Dialect executor contract (move → verify → optional drop). */
export type TenancyMigrateExecutor = {
  migrate(plan: TenancyMigratePlan): Promise<{
    migrated: TenancyMigratedRow[]
    warnings: string[]
  }>
}
