import { resolveEntityTenancy } from '../ast/resolve.js'
import type { SchemaAst } from '../ast/types.js'
import { SchemaPushError } from './errors.js'
import type { EntityPushPlan, SchemaPushOptions, SchemaPushPlan } from './types.js'

const DEFAULT_RLS_SESSION_VAR = 'app.current_tenant_id'

/**
 * Groups entities by resolved concrete tenancy (hybrid resolves per entity).
 * Requires `tenants` when any entity needs bridge/silo namespaces.
 */
export function buildPushPlan(ast: SchemaAst, options?: SchemaPushOptions): SchemaPushPlan {
  const entities: EntityPushPlan[] = ast.entities.map((entity) => {
    if (entity.global === true) {
      return { entity, model: 'global' as const }
    }
    return { entity, model: resolveEntityTenancy(ast, entity.name) }
  })

  const needsTenantNamespaces = entities.some(
    (plan) => plan.model === 'shared-db-isolated-schema' || plan.model === 'single-tenant',
  )

  const tenants = options?.tenants ?? []
  if (needsTenantNamespaces && tenants.length === 0) {
    throw new SchemaPushError(
      'TENANTS_REQUIRED',
      'options.tenants is required when the schema has bridge (shared-db-isolated-schema) or silo (single-tenant) entities',
    )
  }

  for (const tenantId of tenants) {
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new SchemaPushError('INVALID_OPTIONS', 'tenants must be non-empty strings')
    }
  }

  return {
    ast,
    entities,
    tenants,
    needsTenantNamespaces,
    rlsSessionVar: options?.rlsSessionVar ?? DEFAULT_RLS_SESSION_VAR,
  }
}

export function entitiesForModel(
  plan: SchemaPushPlan,
  model: EntityPushPlan['model'],
): EntityPushPlan[] {
  return plan.entities.filter((entry) => entry.model === model)
}
