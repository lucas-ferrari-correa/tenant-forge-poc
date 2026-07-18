import pg from 'pg'
import { createPostgresAdapter } from '../adapters/postgres/adapter.js'
import type { ConcreteTenancyModel } from '../ast/tenancy.js'
import { TENANT_ID_FIELD_NAME } from '../ast/tenancy.js'
import { createTenantContext } from '../ast/tenant-context.js'
import type { EntityDefinition, SchemaAst } from '../ast/types.js'
import { quoteSqlIdent } from '../push/ddl.js'
import { tenantNamespace } from '../push/naming.js'
import { buildQuery } from '../query/build.js'
import { TenancyMigrateError } from './errors.js'
import { destinationFieldNames, projectRow, sourceFieldNames } from './rows.js'
import type { EntityMigrateStep, TenancyMigratedRow, TenancyMigratePlan } from './types.js'

const { Client } = pg

async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

function rewriteDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString)
  url.pathname = `/${databaseName}`
  return url.toString()
}

function findEntity(ast: SchemaAst, name: string): EntityDefinition {
  const entity = ast.entities.find((entry) => entry.name === name)
  if (entity === undefined) {
    throw new TenancyMigrateError('ENTITY_MISSING', `entity "${name}" not found`)
  }
  return entity
}

function qualify(schema: string | undefined, table: string): string {
  const t = quoteSqlIdent('postgres', table)
  if (schema === undefined) {
    return t
  }
  return `${quoteSqlIdent('postgres', schema)}.${t}`
}

type Location =
  | { kind: 'pool' | 'global' }
  | { kind: 'bridge'; schema: string }
  | { kind: 'silo'; database: string }

function locationFor(
  model: ConcreteTenancyModel | 'global',
  tenantId: string | undefined,
): Location {
  if (model === 'global' || model === 'shared-db-shared-schema') {
    return { kind: model === 'global' ? 'global' : 'pool' }
  }
  if (tenantId === undefined) {
    throw new TenancyMigrateError('INVALID_OPTIONS', 'tenant id required for bridge/silo location')
  }
  const ns = tenantNamespace(tenantId)
  if (model === 'shared-db-isolated-schema') {
    return { kind: 'bridge', schema: ns }
  }
  return { kind: 'silo', database: ns }
}

function connectionFor(base: string, loc: Location): string {
  if (loc.kind === 'silo') {
    return rewriteDatabase(base, loc.database)
  }
  return base
}

function tableRef(loc: Location, table: string): string {
  if (loc.kind === 'bridge') {
    return qualify(loc.schema, table)
  }
  return qualify(undefined, table)
}

async function countRows(
  connectionString: string,
  loc: Location,
  table: string,
  tenantFilter?: string,
): Promise<number> {
  return withClient(connectionFor(connectionString, loc), async (client) => {
    const ref = tableRef(loc, table)
    if (tenantFilter !== undefined) {
      const result = await client.query(
        `SELECT COUNT(*)::int AS c FROM ${ref} WHERE ${quoteSqlIdent('postgres', TENANT_ID_FIELD_NAME)} = $1`,
        [tenantFilter],
      )
      return (result.rows[0] as { c: number } | undefined)?.c ?? 0
    }
    const result = await client.query(`SELECT COUNT(*)::int AS c FROM ${ref}`)
    return (result.rows[0] as { c: number } | undefined)?.c ?? 0
  })
}

async function readRows(
  connectionString: string,
  loc: Location,
  entity: EntityDefinition,
  tenantFilter?: string,
): Promise<Record<string, unknown>[]> {
  const fields = sourceFieldNames(entity)
  const cols = fields.map((name) => quoteSqlIdent('postgres', name)).join(', ')
  return withClient(connectionFor(connectionString, loc), async (client) => {
    const ref = tableRef(loc, entity.name)
    if (tenantFilter !== undefined) {
      const result = await client.query(
        `SELECT ${cols} FROM ${ref} WHERE ${quoteSqlIdent('postgres', TENANT_ID_FIELD_NAME)} = $1`,
        [tenantFilter],
      )
      return result.rows as Record<string, unknown>[]
    }
    const result = await client.query(`SELECT ${cols} FROM ${ref}`)
    return result.rows as Record<string, unknown>[]
  })
}

async function insertRows(
  connectionString: string,
  loc: Location,
  entity: EntityDefinition,
  rows: Record<string, unknown>[],
  injectTenantId?: string,
): Promise<number> {
  if (rows.length === 0) {
    return 0
  }
  const destFields = destinationFieldNames(entity)
  const cols = destFields.map((name) => quoteSqlIdent('postgres', name)).join(', ')
  return withClient(connectionFor(connectionString, loc), async (client) => {
    let inserted = 0
    for (const row of rows) {
      const projected = projectRow(row, destFields, injectTenantId)
      const values = destFields.map((name) => projected[name])
      const placeholders = destFields.map((_, i) => `$${i + 1}`).join(', ')
      const pk = entity.fields.find((f) => f.primaryKey === true)
      const conflict =
        pk !== undefined ? ` ON CONFLICT (${quoteSqlIdent('postgres', pk.name)}) DO NOTHING` : ''
      const result = await client.query(
        `INSERT INTO ${tableRef(loc, entity.name)} (${cols}) VALUES (${placeholders})${conflict}`,
        values,
      )
      inserted += result.rowCount ?? 0
    }
    return inserted
  })
}

async function dropSourceObject(
  connectionString: string,
  loc: Location,
  table: string,
): Promise<void> {
  await withClient(connectionFor(connectionString, loc), async (client) => {
    await client.query(`DROP TABLE IF EXISTS ${tableRef(loc, table)} CASCADE`)
  })
}

async function moveTenantEntity(
  connectionString: string,
  step: EntityMigrateStep,
  sourceEntity: EntityDefinition,
  destEntity: EntityDefinition,
  tenantId: string,
  warnings: string[],
): Promise<TenancyMigratedRow> {
  const fromLoc = locationFor(step.from, tenantId)
  const toLoc = locationFor(step.to, tenantId)

  const destCountBefore = await countRows(
    connectionString,
    toLoc,
    destEntity.name,
    step.to === 'shared-db-shared-schema' ? tenantId : undefined,
  )
  if (destCountBefore > 0) {
    warnings.push(
      `skip ${step.entity}/${tenantId}: destination already has ${destCountBefore} rows`,
    )
    return { entity: step.entity, tenant: tenantId, rows: destCountBefore, skipped: true }
  }

  const sourceFilter = step.from === 'shared-db-shared-schema' ? tenantId : undefined
  const expected = await countRows(connectionString, fromLoc, sourceEntity.name, sourceFilter)
  const rows = await readRows(connectionString, fromLoc, sourceEntity, sourceFilter)
  const injectTenant = step.to === 'shared-db-shared-schema' ? tenantId : undefined
  const inserted = await insertRows(connectionString, toLoc, destEntity, rows, injectTenant)

  const actual = await countRows(
    connectionString,
    toLoc,
    destEntity.name,
    step.to === 'shared-db-shared-schema' ? tenantId : undefined,
  )
  if (actual !== expected) {
    throw new TenancyMigrateError(
      'VERIFY_FAILED',
      `count mismatch for ${step.entity}/${tenantId}: expected ${expected}, got ${actual}`,
    )
  }

  return { entity: step.entity, tenant: tenantId, rows: inserted }
}

async function moveGlobal(
  connectionString: string,
  step: EntityMigrateStep,
  destEntity: EntityDefinition,
  warnings: string[],
): Promise<TenancyMigratedRow> {
  const toLoc = locationFor('global', undefined)
  const destCount = await countRows(connectionString, toLoc, destEntity.name)
  warnings.push(`global entity ${step.entity}: already in default database (no-op copy)`)
  return { entity: step.entity, rows: destCount, skipped: true }
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

  const adapter = createPostgresAdapter({ connectionString })
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
  connectionString: string,
  step: EntityMigrateStep,
  tenants: readonly string[],
): Promise<void> {
  if (step.from === 'global') {
    return
  }
  if (step.from === 'shared-db-shared-schema') {
    await dropSourceObject(
      connectionString,
      locationFor('shared-db-shared-schema', undefined),
      step.entity,
    )
    return
  }
  for (const tenantId of tenants) {
    await dropSourceObject(connectionString, locationFor(step.from, tenantId), step.entity)
  }
}

/**
 * Postgres tenancy migrator: move rows between pool/bridge/silo layouts, verify, drop source.
 */
export async function migratePostgresTenancy(
  connectionString: string,
  plan: TenancyMigratePlan,
): Promise<{ migrated: TenancyMigratedRow[]; warnings: string[] }> {
  const migrated: TenancyMigratedRow[] = []
  const warnings: string[] = [
    'tenancy migration is best-effort (POC): not transactional end-to-end; no automatic rollback',
  ]

  try {
    for (const step of plan.steps) {
      if (step.action === 'noop') {
        warnings.push(`entity ${step.entity}: from≡to (${step.from}) — no-op`)
        continue
      }

      const sourceEntity = findEntity(plan.sourceAst, step.entity)
      const destEntity = findEntity(plan.targetAst, step.entity)

      if (step.action === 'copy-global') {
        migrated.push(await moveGlobal(connectionString, step, destEntity, warnings))
        continue
      }

      for (const tenantId of plan.tenants) {
        migrated.push(
          await moveTenantEntity(
            connectionString,
            step,
            sourceEntity,
            destEntity,
            tenantId,
            warnings,
          ),
        )
      }

      await verifyCanary(connectionString, plan.targetAst, step, plan.tenants)

      if (plan.dropSource) {
        await dropAfterMigrate(connectionString, step, plan.tenants)
      }
    }
  } catch (error) {
    if (error instanceof TenancyMigrateError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new TenancyMigrateError('EXECUTION_FAILED', message)
  }

  return { migrated, warnings }
}
