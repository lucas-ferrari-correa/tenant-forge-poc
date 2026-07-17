import {
  type ConcreteTenancyModel,
  type HybridBinding,
  isConcreteTenancyModel,
  type SchemaTenancy,
} from './tenancy.js'
import type { EntityDefinition, SchemaAst, ServiceDefinition } from './types.js'

export class TenancyResolutionError extends Error {
  readonly code = 'TENANCY_RESOLUTION' as const

  constructor(message: string) {
    super(message)
    this.name = 'TenancyResolutionError'
  }
}

function findEntity(ast: SchemaAst, entityName: string): EntityDefinition | undefined {
  return ast.entities.find((entity) => entity.name === entityName)
}

function bindingFor(
  bindings: HybridBinding[],
  scope: HybridBinding['scope'],
  name: string,
): HybridBinding | undefined {
  return bindings.find((binding) => binding.scope === scope && binding.name === name)
}

function serviceOwningEntity(
  services: ServiceDefinition[] | undefined,
  entityName: string,
): ServiceDefinition | undefined {
  if (!services) {
    return undefined
  }
  return services.find((service) => service.entities?.includes(entityName))
}

/**
 * Resolves the concrete tenancy model for an entity.
 * Priority under hybrid: entity.tenancyModel → entity binding → owning service → tier binding
 * (via service name as tier if bound) → defaultModel.
 */
export function resolveEntityTenancy(ast: SchemaAst, entityName: string): ConcreteTenancyModel {
  const entity = findEntity(ast, entityName)
  if (!entity) {
    throw new TenancyResolutionError(`unknown entity: ${entityName}`)
  }

  const { tenancy } = ast
  if (tenancy.model !== 'hybrid') {
    if (entity.tenancyModel !== undefined && entity.tenancyModel !== tenancy.model) {
      throw new TenancyResolutionError(
        `entity "${entityName}" overrides tenancy to "${entity.tenancyModel}" but schema is "${tenancy.model}" (non-hybrid)`,
      )
    }
    return tenancy.model
  }

  if (entity.tenancyModel !== undefined) {
    return entity.tenancyModel
  }

  const entityBinding = bindingFor(tenancy.bindings, 'entity', entityName)
  if (entityBinding) {
    return entityBinding.model
  }

  const owningService = serviceOwningEntity(ast.services, entityName)
  if (owningService) {
    const serviceBinding = bindingFor(tenancy.bindings, 'service', owningService.name)
    if (serviceBinding) {
      return serviceBinding.model
    }
    return owningService.tenancyModel
  }

  if (tenancy.defaultModel !== undefined) {
    return tenancy.defaultModel
  }

  throw new TenancyResolutionError(
    `cannot resolve tenancy for entity "${entityName}" under hybrid schema (no entity/service binding and no defaultModel)`,
  )
}

export function resolveServiceTenancy(
  tenancy: SchemaTenancy,
  service: ServiceDefinition,
): ConcreteTenancyModel {
  if (tenancy.model !== 'hybrid') {
    if (service.tenancyModel !== tenancy.model) {
      throw new TenancyResolutionError(
        `service "${service.name}" declares "${service.tenancyModel}" but schema is "${tenancy.model}" (non-hybrid)`,
      )
    }
    return tenancy.model
  }

  const serviceBinding = bindingFor(tenancy.bindings, 'service', service.name)
  if (serviceBinding) {
    return serviceBinding.model
  }

  return service.tenancyModel
}

export function listConcreteModelsInSchema(ast: SchemaAst): ConcreteTenancyModel[] {
  if (ast.tenancy.model !== 'hybrid') {
    return [ast.tenancy.model]
  }

  const models = new Set<ConcreteTenancyModel>()
  if (ast.tenancy.defaultModel !== undefined) {
    models.add(ast.tenancy.defaultModel)
  }
  for (const binding of ast.tenancy.bindings) {
    models.add(binding.model)
  }
  for (const entity of ast.entities) {
    if (entity.tenancyModel !== undefined) {
      models.add(entity.tenancyModel)
    }
  }
  for (const service of ast.services ?? []) {
    models.add(service.tenancyModel)
  }
  return [...models]
}

export function assertConcreteTenancyModel(value: string): ConcreteTenancyModel {
  if (!isConcreteTenancyModel(value)) {
    throw new TenancyResolutionError(`expected concrete tenancy model, got: ${value}`)
  }
  return value
}
