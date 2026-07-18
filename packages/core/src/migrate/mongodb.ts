import { MongoClient } from 'mongodb'
import { createMongodbAdapter } from '../adapters/mongodb/adapter.js'
import type { ConcreteTenancyModel } from '../ast/tenancy.js'
import { TENANT_ID_FIELD_NAME } from '../ast/tenancy.js'
import { createTenantContext } from '../ast/tenant-context.js'
import type { EntityDefinition, SchemaAst } from '../ast/types.js'
import { tenantNamespace } from '../push/naming.js'
import { buildQuery } from '../query/build.js'
import { TenancyMigrateError } from './errors.js'
import { destinationFieldNames, projectRow } from './rows.js'
import type { EntityMigrateStep, TenancyMigratedRow, TenancyMigratePlan } from './types.js'

function defaultDatabase(connectionString: string): string {
  const url = new URL(connectionString)
  const path = url.pathname.replace(/^\//, '')
  return path.length > 0 ? path : 'test'
}

function findEntity(ast: SchemaAst, name: string): EntityDefinition {
  const entity = ast.entities.find((entry) => entry.name === name)
  if (entity === undefined) {
    throw new TenancyMigrateError('ENTITY_MISSING', `entity "${name}" not found`)
  }
  return entity
}

/** Mongo: pool/global → default DB; bridge AND silo → `tenant_${slug}` (same gap as MySQL). */
function databaseFor(
  model: ConcreteTenancyModel | 'global',
  tenantId: string | undefined,
  defaultDb: string,
): string {
  if (model === 'global' || model === 'shared-db-shared-schema') {
    return defaultDb
  }
  if (tenantId === undefined) {
    throw new TenancyMigrateError('INVALID_OPTIONS', 'tenant id required for bridge/silo location')
  }
  return tenantNamespace(tenantId)
}

async function withClient<T>(
  connectionString: string,
  fn: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const client = new MongoClient(connectionString)
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

async function countDocs(
  client: MongoClient,
  database: string,
  collection: string,
  filter: Record<string, unknown> = {},
): Promise<number> {
  return client.db(database).collection(collection).countDocuments(filter)
}

async function readDocs(
  client: MongoClient,
  database: string,
  collection: string,
  filter: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const docs = await client.db(database).collection(collection).find(filter).toArray()
  return docs.map((doc) => {
    const { _id: _ignored, ...rest } = doc as Record<string, unknown> & { _id?: unknown }
    return rest
  })
}

async function insertDocs(
  client: MongoClient,
  database: string,
  entity: EntityDefinition,
  rows: Record<string, unknown>[],
  injectTenantId?: string,
): Promise<number> {
  if (rows.length === 0) {
    return 0
  }
  const destFields = destinationFieldNames(entity)
  const projected = rows.map((row) => projectRow(row, destFields, injectTenantId))
  const col = client.db(database).collection(entity.name)
  let inserted = 0
  for (const doc of projected) {
    const pk = entity.fields.find((f) => f.primaryKey === true)
    if (pk !== undefined && doc[pk.name] !== undefined) {
      const existing = await col.findOne({ [pk.name]: doc[pk.name] })
      if (existing !== null) {
        continue
      }
    }
    await col.insertOne(doc)
    inserted += 1
  }
  return inserted
}

async function dropCollection(
  client: MongoClient,
  database: string,
  collection: string,
): Promise<void> {
  const existing = await client.db(database).listCollections({ name: collection }).toArray()
  if (existing.length > 0) {
    await client.db(database).collection(collection).drop()
  }
}

async function moveTenantEntity(
  client: MongoClient,
  defaultDb: string,
  step: EntityMigrateStep,
  destEntity: EntityDefinition,
  tenantId: string,
  warnings: string[],
): Promise<TenancyMigratedRow> {
  const fromDb = databaseFor(step.from, tenantId, defaultDb)
  const toDb = databaseFor(step.to, tenantId, defaultDb)

  if (
    fromDb === toDb &&
    step.from !== 'shared-db-shared-schema' &&
    step.to !== 'shared-db-shared-schema'
  ) {
    warnings.push(
      `${step.entity}/${tenantId}: Mongo bridge↔silo share database ${fromDb} (Fase 8 gap) — no physical move`,
    )
    const count = await countDocs(client, toDb, destEntity.name)
    return { entity: step.entity, tenant: tenantId, rows: count, skipped: true }
  }

  const destFilter =
    step.to === 'shared-db-shared-schema' ? { [TENANT_ID_FIELD_NAME]: tenantId } : {}
  const destCountBefore = await countDocs(client, toDb, destEntity.name, destFilter)
  if (destCountBefore > 0) {
    warnings.push(
      `skip ${step.entity}/${tenantId}: destination already has ${destCountBefore} rows`,
    )
    return { entity: step.entity, tenant: tenantId, rows: destCountBefore, skipped: true }
  }

  const sourceFilter =
    step.from === 'shared-db-shared-schema' ? { [TENANT_ID_FIELD_NAME]: tenantId } : {}
  const expected = await countDocs(client, fromDb, destEntity.name, sourceFilter)
  const rows = await readDocs(client, fromDb, destEntity.name, sourceFilter)
  const injectTenant = step.to === 'shared-db-shared-schema' ? tenantId : undefined
  const inserted = await insertDocs(client, toDb, destEntity, rows, injectTenant)

  const actual = await countDocs(client, toDb, destEntity.name, destFilter)
  if (actual !== expected) {
    throw new TenancyMigrateError(
      'VERIFY_FAILED',
      `count mismatch for ${step.entity}/${tenantId}: expected ${expected}, got ${actual}`,
    )
  }

  return { entity: step.entity, tenant: tenantId, rows: inserted }
}

async function verifyCanary(
  connectionString: string,
  targetAst: SchemaAst,
  step: EntityMigrateStep,
  tenants: readonly string[],
): Promise<void> {
  if (step.to === 'global' || tenants.length < 2) {
    return
  }
  const tenantA = tenants[0]
  const tenantB = tenants[1]
  if (tenantA === undefined || tenantB === undefined) {
    return
  }

  const adapter = createMongodbAdapter({ connectionString })
  try {
    const rowsA = await adapter.execute(
      buildQuery(targetAst, createTenantContext({ tenantId: tenantA, source: 'jwt-claim' }), {
        operation: 'findMany',
        entity: step.entity,
      }),
    )
    const rowsB = await adapter.execute(
      buildQuery(targetAst, createTenantContext({ tenantId: tenantB, source: 'jwt-claim' }), {
        operation: 'findMany',
        entity: step.entity,
      }),
    )
    const listA = Array.isArray(rowsA) ? rowsA : []
    const listB = Array.isArray(rowsB) ? rowsB : []
    const idsA = new Set(listA.map((row) => String(row.id)))
    for (const row of listB) {
      const id = String(row.id)
      if (idsA.has(id)) {
        throw new TenancyMigrateError(
          'VERIFY_FAILED',
          `canary isolation failed for ${step.entity}: tenant ${tenantA} and ${tenantB} share id ${id}`,
        )
      }
    }
  } finally {
    await adapter.dispose()
  }
}

async function dropAfterMigrate(
  client: MongoClient,
  defaultDb: string,
  step: EntityMigrateStep,
  tenants: readonly string[],
): Promise<void> {
  if (step.from === 'global') {
    return
  }
  if (
    (step.from === 'shared-db-isolated-schema' || step.from === 'single-tenant') &&
    (step.to === 'shared-db-isolated-schema' || step.to === 'single-tenant')
  ) {
    return
  }
  if (step.from === 'shared-db-shared-schema') {
    await dropCollection(client, defaultDb, step.entity)
    return
  }
  for (const tenantId of tenants) {
    await dropCollection(client, databaseFor(step.from, tenantId, defaultDb), step.entity)
  }
}

/**
 * MongoDB tenancy migrator. Bridge/silo share `tenant_*` DBs — physical move only for pool edges.
 */
export async function migrateMongodbTenancy(
  connectionString: string,
  plan: TenancyMigratePlan,
): Promise<{ migrated: TenancyMigratedRow[]; warnings: string[] }> {
  const migrated: TenancyMigratedRow[] = []
  const warnings: string[] = [
    'tenancy migration is best-effort (POC): not transactional end-to-end; no automatic rollback',
  ]
  const defaultDb = defaultDatabase(connectionString)

  try {
    await withClient(connectionString, async (client) => {
      for (const step of plan.steps) {
        if (step.action === 'noop') {
          warnings.push(`entity ${step.entity}: from≡to (${step.from}) — no-op`)
          continue
        }

        const destEntity = findEntity(plan.targetAst, step.entity)

        if (step.action === 'copy-global') {
          const count = await countDocs(client, defaultDb, destEntity.name)
          warnings.push(`global entity ${step.entity}: already in default database (no-op copy)`)
          migrated.push({ entity: step.entity, rows: count, skipped: true })
          continue
        }

        for (const tenantId of plan.tenants) {
          migrated.push(
            await moveTenantEntity(client, defaultDb, step, destEntity, tenantId, warnings),
          )
        }

        await verifyCanary(connectionString, plan.targetAst, step, plan.tenants)

        if (plan.dropSource) {
          await dropAfterMigrate(client, defaultDb, step, plan.tenants)
        }
      }
    })
  } catch (error) {
    if (error instanceof TenancyMigrateError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new TenancyMigrateError('EXECUTION_FAILED', message)
  }

  return { migrated, warnings }
}
