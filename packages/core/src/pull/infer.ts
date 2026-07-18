import type { ConcreteTenancyModel } from '../ast/tenancy.js'
import { type CatalogObject, type CatalogSnapshot, hasTenantIdColumn } from './catalog.js'
import { SchemaPullError } from './errors.js'
import type { InferredEntityTenancy, SchemaPullDialect, SchemaPullOptions } from './types.js'

export type EntityLayoutSignals = {
  entityName: string
  /** Representative object used for field/FK extraction (prefer default, else first). */
  representative: CatalogObject
  inDefaultWithTenantId: boolean
  inDefaultWithoutTenantId: boolean
  inTenantSchemasWithoutTenantId: boolean
  inTenantDatabasesWithoutTenantId: boolean
  inTenantNamespaceWithTenantId: boolean
  rlsStrongSignal: boolean
  appearanceCount: number
}

export type InferTenancyResult = {
  inferred: InferredEntityTenancy[]
  warnings: string[]
}

function collectSignals(snapshot: CatalogSnapshot): EntityLayoutSignals[] {
  const byName = new Map<string, CatalogObject[]>()
  for (const object of snapshot.objects) {
    const list = byName.get(object.name) ?? []
    list.push(object)
    byName.set(object.name, list)
  }

  const result: EntityLayoutSignals[] = []
  for (const [entityName, appearances] of byName) {
    let inDefaultWithTenantId = false
    let inDefaultWithoutTenantId = false
    let inTenantSchemasWithoutTenantId = false
    let inTenantDatabasesWithoutTenantId = false
    let inTenantNamespaceWithTenantId = false
    let rlsStrongSignal = false
    let representative: CatalogObject | undefined

    for (const object of appearances) {
      const hasTenantId = hasTenantIdColumn(object.columns)

      if (object.namespaceKind === 'default') {
        if (hasTenantId) {
          inDefaultWithTenantId = true
        } else {
          inDefaultWithoutTenantId = true
        }
        if (representative === undefined || representative.namespaceKind !== 'default') {
          representative = object
        }
        if (object.rlsEnabled === true && object.rlsTenantPolicy === true) {
          rlsStrongSignal = true
        }
      } else if (object.namespaceKind === 'tenant-schema') {
        if (hasTenantId) {
          inTenantNamespaceWithTenantId = true
        } else {
          inTenantSchemasWithoutTenantId = true
        }
        representative ??= object
      } else if (object.namespaceKind === 'tenant-database') {
        if (hasTenantId) {
          inTenantNamespaceWithTenantId = true
        } else {
          inTenantDatabasesWithoutTenantId = true
        }
        representative ??= object
      }
    }

    if (representative === undefined) {
      continue
    }

    result.push({
      entityName,
      representative,
      inDefaultWithTenantId,
      inDefaultWithoutTenantId,
      inTenantSchemasWithoutTenantId,
      inTenantDatabasesWithoutTenantId,
      inTenantNamespaceWithTenantId,
      rlsStrongSignal,
      appearanceCount: appearances.length,
    })
  }

  return result.sort((a, b) => a.entityName.localeCompare(b.entityName))
}

function ambiguous(message: string, entity?: string): never {
  const prefix = entity !== undefined ? `entity "${entity}": ` : ''
  throw new SchemaPullError('AMBIGUOUS_TENANCY', `${prefix}${message}`)
}

function resolveHint(
  entityName: string,
  options: SchemaPullOptions | undefined,
): ConcreteTenancyModel | 'global' | undefined {
  const entityHint = options?.entityTenancy?.[entityName]
  if (entityHint !== undefined) {
    return entityHint
  }
  return undefined
}

/**
 * Classify a single entity from layout signals.
 * Pure function — exported for unit tests.
 */
export function classifyEntityTenancy(
  signals: EntityLayoutSignals,
  dialect: SchemaPullDialect,
  options?: SchemaPullOptions,
): InferredEntityTenancy {
  const entityHint = resolveHint(signals.entityName, options)
  if (entityHint !== undefined) {
    return {
      entity: signals.entityName,
      model: entityHint,
      signals: [`entityTenancy hint → ${entityHint}`],
      fromHint: true,
    }
  }

  const used: string[] = []

  if (signals.inTenantNamespaceWithTenantId) {
    if (options?.assumeTenancy !== undefined) {
      used.push('tenant_id inside tenant_* (conflict)')
      used.push(`assumeTenancy → ${options.assumeTenancy}`)
      return {
        entity: signals.entityName,
        model: options.assumeTenancy,
        signals: used,
        fromHint: true,
      }
    }
    ambiguous(
      'tenant_id found inside tenant_* namespace (conflicting pool + bridge/silo signals)',
      signals.entityName,
    )
  }

  const hasNamespaceClone =
    signals.inTenantSchemasWithoutTenantId || signals.inTenantDatabasesWithoutTenantId

  // Never assume pool solely from tenant_id when bridge/silo layout also present.
  if (signals.inDefaultWithTenantId && hasNamespaceClone) {
    if (options?.assumeTenancy !== undefined) {
      used.push('tenant_id in default AND clones in tenant_* (conflict)')
      used.push(`assumeTenancy → ${options.assumeTenancy}`)
      return {
        entity: signals.entityName,
        model: options.assumeTenancy,
        signals: used,
        fromHint: true,
      }
    }
    ambiguous(
      'conflicting signals: tenant_id in default namespace and copies in tenant_*',
      signals.entityName,
    )
  }

  if (signals.inDefaultWithTenantId) {
    used.push('default namespace + tenant_id column')
    if (signals.rlsStrongSignal) {
      used.push('RLS + current_setting(app.current_tenant_id)')
    }
    return {
      entity: signals.entityName,
      model: 'shared-db-shared-schema',
      signals: used,
    }
  }

  // Namespace clones without tenant_id
  if (signals.inTenantSchemasWithoutTenantId && signals.inTenantDatabasesWithoutTenantId) {
    // Same entity in both PG schemas and separate DBs — rare / conflicting
    if (options?.assumeTenancy !== undefined) {
      used.push('present in tenant_* schemas and tenant_* databases')
      used.push(`assumeTenancy → ${options.assumeTenancy}`)
      return {
        entity: signals.entityName,
        model: options.assumeTenancy,
        signals: used,
        fromHint: true,
      }
    }
    ambiguous('entity appears in both tenant_* schemas and tenant_* databases', signals.entityName)
  }

  if (signals.inTenantSchemasWithoutTenantId) {
    used.push('repeated in tenant_* schemas (same database) without tenant_id')
    return {
      entity: signals.entityName,
      model: 'shared-db-isolated-schema',
      signals: used,
    }
  }

  if (signals.inTenantDatabasesWithoutTenantId) {
    if (dialect === 'postgres') {
      used.push('repeated in tenant_* databases without tenant_id')
      return {
        entity: signals.entityName,
        model: 'single-tenant',
        signals: used,
      }
    }

    // MySQL / Mongo: DB≈namespace — cannot distinguish bridge × silo
    if (options?.assumeTenancy !== undefined) {
      used.push(`${dialect}: tenant_* databases without tenant_id (bridge×silo ambiguous)`)
      used.push(`assumeTenancy → ${options.assumeTenancy}`)
      return {
        entity: signals.entityName,
        model: options.assumeTenancy,
        signals: used,
        fromHint: true,
      }
    }
    ambiguous(
      `${dialect}: tenant_* database layout does not distinguish bridge (shared-db-isolated-schema) from silo (single-tenant); pass options.assumeTenancy or entityTenancy`,
      signals.entityName,
    )
  }

  if (signals.inDefaultWithoutTenantId) {
    used.push('default namespace only, no tenant_id, no tenant_* clones')
    return {
      entity: signals.entityName,
      model: 'global',
      signals: used,
    }
  }

  if (options?.assumeTenancy !== undefined) {
    used.push('no deterministic layout signals')
    used.push(`assumeTenancy → ${options.assumeTenancy}`)
    return {
      entity: signals.entityName,
      model: options.assumeTenancy,
      signals: used,
      fromHint: true,
    }
  }

  ambiguous('no useful tenancy signals for entity', signals.entityName)
}

/**
 * Infer per-entity tenancy from a catalog snapshot.
 * Fail-closed with AMBIGUOUS_TENANCY when heuristic is non-deterministic and no hint.
 */
export function inferTenancyFromCatalog(
  snapshot: CatalogSnapshot,
  options?: SchemaPullOptions,
): InferTenancyResult {
  if (snapshot.objects.length === 0) {
    throw new SchemaPullError(
      'AMBIGUOUS_TENANCY',
      'database is empty or has no useful tenancy signals; pass options.assumeTenancy if provisioning a known model',
    )
  }

  const allSignals = collectSignals(snapshot)
  if (allSignals.length === 0) {
    throw new SchemaPullError(
      'AMBIGUOUS_TENANCY',
      'database is empty or has no useful tenancy signals; pass options.assumeTenancy if provisioning a known model',
    )
  }

  const warnings: string[] = []
  const inferred: InferredEntityTenancy[] = []

  for (const signals of allSignals) {
    inferred.push(classifyEntityTenancy(signals, snapshot.dialect, options))
  }

  return { inferred, warnings }
}

/** Exported for unit tests — build signals without a live database. */
export function buildEntitySignalsFromObjects(objects: CatalogObject[]): EntityLayoutSignals[] {
  return collectSignals({
    dialect: 'postgres',
    defaultNamespace: 'public',
    objects,
    tenantSchemas: [],
    tenantDatabases: [],
  })
}
