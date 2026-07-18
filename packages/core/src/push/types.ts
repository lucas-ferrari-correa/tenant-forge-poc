import type { ConcreteTenancyModel } from '../ast/tenancy.js'
import type { EntityDefinition, SchemaAst } from '../ast/types.js'

export type SchemaPushDialect = 'postgres' | 'mysql' | 'mongodb'

export type SchemaPushTarget = {
  dialect: SchemaPushDialect
  connectionString: string
}

/**
 * Options for forward engineering.
 * `tenants` is required when any non-global entity resolves to bridge or silo.
 */
export type SchemaPushOptions = {
  /**
   * Tenant ids to provision namespaces/DBs for (bridge/silo).
   * Naming: `tenant_${slug}` — matches query IsolationStrategy.
   */
  tenants?: readonly string[]
  /** Postgres RLS GUC (default: app.current_tenant_id). */
  rlsSessionVar?: string
}

export type SchemaPushObjectKind =
  | 'database'
  | 'schema'
  | 'table'
  | 'collection'
  | 'index'
  | 'policy'
  | 'rls'

export type SchemaPushCreatedObject = {
  kind: SchemaPushObjectKind
  name: string
  /** Namespace / database when applicable. */
  namespace?: string
  tenancyModel?: ConcreteTenancyModel | 'global'
}

export type SchemaPushResult = {
  dialect: SchemaPushDialect
  created: SchemaPushCreatedObject[]
  /**
   * Explicit degradations (e.g. Mongo has no FK constraints).
   */
  warnings: string[]
}

export type EntityPushPlan = {
  entity: EntityDefinition
  model: ConcreteTenancyModel | 'global'
}

export type SchemaPushPlan = {
  ast: SchemaAst
  entities: EntityPushPlan[]
  /** Distinct tenants to provision when bridge/silo entities exist. */
  tenants: readonly string[]
  needsTenantNamespaces: boolean
  rlsSessionVar: string
}
