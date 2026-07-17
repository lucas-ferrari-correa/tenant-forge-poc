/**
 * Tenancy taxonomy mirrors docs/multitenancy-architecture (01-fundamentos).
 * Course models ↔ market aliases (silo / bridge / pool).
 */

export const TENANCY_MODELS = [
  'single-tenant',
  'shared-db-isolated-schema',
  'shared-db-shared-schema',
  'hybrid',
] as const

export type TenancyModel = (typeof TENANCY_MODELS)[number]

/** Concrete models only — hybrid is a composition, not a physical isolation strategy. */
export type ConcreteTenancyModel = Exclude<TenancyModel, 'hybrid'>

export const CONCRETE_TENANCY_MODELS = [
  'single-tenant',
  'shared-db-isolated-schema',
  'shared-db-shared-schema',
] as const satisfies readonly ConcreteTenancyModel[]

/** AWS Well-Architected SaaS Lens aliases (doc § Vocabulário). */
export type TenancyMarketAlias = 'silo' | 'bridge' | 'pool'

export const TENANCY_MARKET_ALIAS: Record<ConcreteTenancyModel, TenancyMarketAlias> = {
  'single-tenant': 'silo',
  'shared-db-isolated-schema': 'bridge',
  'shared-db-shared-schema': 'pool',
}

export const TENANT_ID_FIELD_NAME = 'tenant_id' as const

export type HybridBindingScope = 'entity' | 'service' | 'tier'

export type HybridBinding = {
  scope: HybridBindingScope
  /** Entity name, service name, or tier name depending on `scope`. */
  name: string
  model: ConcreteTenancyModel
}

export type SchemaTenancy =
  | { model: 'single-tenant' }
  | { model: 'shared-db-isolated-schema' }
  | { model: 'shared-db-shared-schema' }
  | {
      model: 'hybrid'
      bindings: HybridBinding[]
      /** Fallback when an entity has no binding and no entity-level override. */
      defaultModel?: ConcreteTenancyModel
    }

export function isTenancyModel(value: string): value is TenancyModel {
  return (TENANCY_MODELS as readonly string[]).includes(value)
}

export function isConcreteTenancyModel(value: string): value is ConcreteTenancyModel {
  return (CONCRETE_TENANCY_MODELS as readonly string[]).includes(value)
}

/** Pool model isolates via `tenant_id` column (+ RLS at adapter time). */
export function requiresTenantIdColumn(model: ConcreteTenancyModel): boolean {
  return model === 'shared-db-shared-schema'
}

/** Bridge model isolates via schema/`search_path` (or DB namespace) — no `tenant_id`. */
export function usesSchemaIsolation(model: ConcreteTenancyModel): boolean {
  return model === 'shared-db-isolated-schema'
}

/** Silo model isolates via dedicated instance/database. */
export function usesPhysicalIsolation(model: ConcreteTenancyModel): boolean {
  return model === 'single-tenant'
}
