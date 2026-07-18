import type { ConcreteTenancyModel } from '../ast/tenancy.js'
import type { SchemaAst } from '../ast/types.js'

export type SchemaPullDialect = 'postgres' | 'mysql' | 'mongodb'

export type SchemaPullTarget = {
  dialect: SchemaPullDialect
  connectionString: string
}

/**
 * Hints when auto-inference is non-deterministic (fail-closed otherwise).
 */
export type SchemaPullOptions = {
  /**
   * Default concrete model when the whole layout is ambiguous
   * (e.g. MySQL/Mongo bridge×silo — DB≈namespace).
   * Applied to entities that need a namespace-based model and have no entityTenancy override.
   */
  assumeTenancy?: ConcreteTenancyModel
  /**
   * Per-entity override (`global` or a concrete model).
   * Wins over assumeTenancy and auto classification when set.
   */
  entityTenancy?: Record<string, ConcreteTenancyModel | 'global'>
  /**
   * Regex for tenant namespaces (`tenant_${slug}`). Default: `/^tenant_/`.
   */
  tenantNamespacePattern?: RegExp
  /** Schema AST name when introspected (default: `pulled`). */
  schemaName?: string
  /** Postgres RLS GUC expected in policies (default: `app.current_tenant_id`). */
  rlsSessionVar?: string
}

export type InferredEntityTenancy = {
  entity: string
  /** Resolved model after hints + heuristic. */
  model: ConcreteTenancyModel | 'global'
  /** Human-readable signals that drove the decision. */
  signals: string[]
  /** True when a user hint resolved ambiguity. */
  fromHint?: boolean
}

export type SchemaPullResult = {
  dialect: SchemaPullDialect
  ast: SchemaAst
  inferred: InferredEntityTenancy[]
  warnings: string[]
}
