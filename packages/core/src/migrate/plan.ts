import { resolveEntityTenancy } from '../ast/resolve.js'
import type { ConcreteTenancyModel } from '../ast/tenancy.js'
import { isConcreteTenancyModel } from '../ast/tenancy.js'
import type { SchemaAst } from '../ast/types.js'
import { TenancyMigrateError } from './errors.js'
import type { EntityMigrateStep, TenancyMigrateOptions, TenancyMigratePlan } from './types.js'

const DEFAULT_RLS_SESSION_VAR = 'app.current_tenant_id'

const CONCRETE: ReadonlySet<string> = new Set([
  'single-tenant',
  'shared-db-isolated-schema',
  'shared-db-shared-schema',
])

function resolveModel(ast: SchemaAst, entityName: string): ConcreteTenancyModel | 'global' {
  const entity = ast.entities.find((entry) => entry.name === entityName)
  if (entity === undefined) {
    throw new TenancyMigrateError('ENTITY_MISSING', `entity "${entityName}" not found in schema`)
  }
  if (entity.global === true) {
    return 'global'
  }
  return resolveEntityTenancy(ast, entityName)
}

/**
 * True when both ends are concrete models (any of the 6 directed edges).
 * global→global is handled separately; concrete↔global is unsupported.
 */
export function isSupportedTransition(
  from: ConcreteTenancyModel | 'global',
  to: ConcreteTenancyModel | 'global',
): boolean {
  if (from === to) {
    return true
  }
  if (from === 'global' || to === 'global') {
    return from === 'global' && to === 'global'
  }
  return CONCRETE.has(from) && CONCRETE.has(to)
}

function stepAction(
  from: ConcreteTenancyModel | 'global',
  to: ConcreteTenancyModel | 'global',
): EntityMigrateStep['action'] {
  if (from === 'global' && to === 'global') {
    return 'copy-global'
  }
  if (from === to) {
    return 'noop'
  }
  return 'migrate'
}

/**
 * Build a per-entity migration plan from source tenancy → target AST.
 * Hybrid resolves concrete models per entity via resolveEntityTenancy.
 */
export function buildMigratePlan(
  sourceAst: SchemaAst,
  targetAst: SchemaAst,
  options: TenancyMigrateOptions,
): TenancyMigratePlan {
  const tenants = options.tenants
  if (tenants === undefined || tenants.length === 0) {
    throw new TenancyMigrateError(
      'TENANTS_REQUIRED',
      'options.tenants is required (non-empty) for tenancy migration',
    )
  }
  for (const tenantId of tenants) {
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new TenancyMigrateError('INVALID_OPTIONS', 'tenants must be non-empty strings')
    }
  }

  const steps: EntityMigrateStep[] = []

  for (const entity of targetAst.entities) {
    const sourceEntity = sourceAst.entities.find((entry) => entry.name === entity.name)
    if (sourceEntity === undefined) {
      throw new TenancyMigrateError(
        'ENTITY_MISSING',
        `target entity "${entity.name}" is missing from source schema`,
      )
    }

    const from = resolveModel(sourceAst, entity.name)
    const to = resolveModel(targetAst, entity.name)

    if (!isSupportedTransition(from, to)) {
      throw new TenancyMigrateError(
        'UNSUPPORTED_TRANSITION',
        `unsupported tenancy transition for "${entity.name}": ${from} → ${to}`,
      )
    }

    steps.push({
      entity: entity.name,
      from,
      to,
      action: stepAction(from, to),
    })
  }

  return {
    sourceAst,
    targetAst,
    tenants,
    steps,
    dropSource: options.dropSource !== false,
    rlsSessionVar: options.rlsSessionVar ?? DEFAULT_RLS_SESSION_VAR,
  }
}

/** Exported for unit tests — validates concrete model strings. */
export function assertConcreteOrGlobal(value: string): ConcreteTenancyModel | 'global' {
  if (value === 'global') {
    return 'global'
  }
  if (!isConcreteTenancyModel(value)) {
    throw new TenancyMigrateError('INVALID_OPTIONS', `invalid tenancy model: ${value}`)
  }
  return value
}
