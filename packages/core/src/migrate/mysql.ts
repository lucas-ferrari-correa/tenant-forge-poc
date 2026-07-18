import mysql from 'mysql2/promise'
import { createMysqlAdapter } from '../adapters/mysql/adapter.js'
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

async function withConnection<T>(
  connectionString: string,
  fn: (connection: mysql.Connection) => Promise<T>,
): Promise<T> {
  const connection = await mysql.createConnection(connectionString)
  try {
    return await fn(connection)
  } finally {
    await connection.end()
  }
}

function defaultDatabase(connectionString: string): string {
  const url = new URL(connectionString)
  return url.pathname.replace(/^\//, '') || 'test'
}

function findEntity(ast: SchemaAst, name: string): EntityDefinition {
  const entity = ast.entities.find((entry) => entry.name === name)
  if (entity === undefined) {
    throw new TenancyMigrateError('ENTITY_MISSING', `entity "${name}" not found`)
  }
  return entity
}

/**
 * MySQL: pool/global → default DB; bridge AND silo → database `tenant_${slug}`
 * (gap: bridge×silo share the same physical namespace — documented in Fase 8).
 */
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

function qualify(database: string, table: string): string {
  return `${quoteSqlIdent('mysql', database)}.${quoteSqlIdent('mysql', table)}`
}

async function countRows(
  connectionString: string,
  database: string,
  table: string,
  tenantFilter?: string,
): Promise<number> {
  return withConnection(connectionString, async (connection) => {
    const ref = qualify(database, table)
    if (tenantFilter !== undefined) {
      const [rows] = await connection.query(
        `SELECT COUNT(*) AS c FROM ${ref} WHERE ${quoteSqlIdent('mysql', TENANT_ID_FIELD_NAME)} = ?`,
        [tenantFilter],
      )
      const row = (rows as Array<{ c: number }>)[0]
      return Number(row?.c ?? 0)
    }
    const [rows] = await connection.query(`SELECT COUNT(*) AS c FROM ${ref}`)
    const row = (rows as Array<{ c: number }>)[0]
    return Number(row?.c ?? 0)
  })
}

async function readRows(
  connectionString: string,
  database: string,
  entity: EntityDefinition,
  tenantFilter?: string,
): Promise<Record<string, unknown>[]> {
  const fields = sourceFieldNames(entity)
  const cols = fields.map((name) => quoteSqlIdent('mysql', name)).join(', ')
  return withConnection(connectionString, async (connection) => {
    const ref = qualify(database, entity.name)
    if (tenantFilter !== undefined) {
      const [rows] = await connection.query(
        `SELECT ${cols} FROM ${ref} WHERE ${quoteSqlIdent('mysql', TENANT_ID_FIELD_NAME)} = ?`,
        [tenantFilter],
      )
      return rows as Record<string, unknown>[]
    }
    const [rows] = await connection.query(`SELECT ${cols} FROM ${ref}`)
    return rows as Record<string, unknown>[]
  })
}

async function insertRows(
  connectionString: string,
  database: string,
  entity: EntityDefinition,
  rows: Record<string, unknown>[],
  injectTenantId?: string,
): Promise<number> {
  if (rows.length === 0) {
    return 0
  }
  const destFields = destinationFieldNames(entity)
  const cols = destFields.map((name) => quoteSqlIdent('mysql', name)).join(', ')
  const placeholders = destFields.map(() => '?').join(', ')
  return withConnection(connectionString, async (connection) => {
    let inserted = 0
    for (const row of rows) {
      const projected = projectRow(row, destFields, injectTenantId)
      const values = destFields.map((name) => projected[name])
      try {
        const [result] = await connection.query(
          `INSERT INTO ${qualify(database, entity.name)} (${cols}) VALUES (${placeholders})`,
          values,
        )
        const header = result as mysql.ResultSetHeader
        inserted += header.affectedRows
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Duplicate PK — idempotent skip
        if (/Duplicate entry/i.test(message)) {
          continue
        }
        throw error
      }
    }
    return inserted
  })
}

async function dropTable(connectionString: string, database: string, table: string): Promise<void> {
  await withConnection(connectionString, async (connection) => {
    await connection.query(`DROP TABLE IF EXISTS ${qualify(database, table)}`)
  })
}

async function moveTenantEntity(
  connectionString: string,
  defaultDb: string,
  step: EntityMigrateStep,
  sourceEntity: EntityDefinition,
  destEntity: EntityDefinition,
  tenantId: string,
  warnings: string[],
): Promise<TenancyMigratedRow> {
  // bridge↔silo on MySQL: same physical DB — warn and treat as no-op move when locations match
  const fromDb = databaseFor(step.from, tenantId, defaultDb)
  const toDb = databaseFor(step.to, tenantId, defaultDb)

  if (
    fromDb === toDb &&
    step.from !== 'shared-db-shared-schema' &&
    step.to !== 'shared-db-shared-schema'
  ) {
    warnings.push(
      `${step.entity}/${tenantId}: MySQL bridge↔silo share database ${fromDb} (Fase 8 gap) — no physical move`,
    )
    const count = await countRows(connectionString, toDb, destEntity.name)
    return { entity: step.entity, tenant: tenantId, rows: count, skipped: true }
  }

  const destFilter = step.to === 'shared-db-shared-schema' ? tenantId : undefined
  const destCountBefore = await countRows(connectionString, toDb, destEntity.name, destFilter)
  if (destCountBefore > 0) {
    warnings.push(
      `skip ${step.entity}/${tenantId}: destination already has ${destCountBefore} rows`,
    )
    return { entity: step.entity, tenant: tenantId, rows: destCountBefore, skipped: true }
  }

  const sourceFilter = step.from === 'shared-db-shared-schema' ? tenantId : undefined
  const expected = await countRows(connectionString, fromDb, sourceEntity.name, sourceFilter)
  const rows = await readRows(connectionString, fromDb, sourceEntity, sourceFilter)
  const injectTenant = step.to === 'shared-db-shared-schema' ? tenantId : undefined
  const inserted = await insertRows(connectionString, toDb, destEntity, rows, injectTenant)

  const actual = await countRows(connectionString, toDb, destEntity.name, destFilter)
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

  const adapter = createMysqlAdapter({ connectionString })
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
  defaultDb: string,
  step: EntityMigrateStep,
  tenants: readonly string[],
): Promise<void> {
  if (step.from === 'global') {
    return
  }
  // Don't drop if bridge↔silo noop (same DB still holds the destination).
  if (
    (step.from === 'shared-db-isolated-schema' || step.from === 'single-tenant') &&
    (step.to === 'shared-db-isolated-schema' || step.to === 'single-tenant')
  ) {
    return
  }
  if (step.from === 'shared-db-shared-schema') {
    await dropTable(connectionString, defaultDb, step.entity)
    return
  }
  for (const tenantId of tenants) {
    await dropTable(connectionString, databaseFor(step.from, tenantId, defaultDb), step.entity)
  }
}

/**
 * MySQL tenancy migrator. Bridge/silo share `tenant_*` DBs — physical move only for pool edges.
 */
export async function migrateMysqlTenancy(
  connectionString: string,
  plan: TenancyMigratePlan,
): Promise<{ migrated: TenancyMigratedRow[]; warnings: string[] }> {
  const migrated: TenancyMigratedRow[] = []
  const warnings: string[] = [
    'tenancy migration is best-effort (POC): not transactional end-to-end; no automatic rollback',
  ]
  const defaultDb = defaultDatabase(connectionString)

  try {
    for (const step of plan.steps) {
      if (step.action === 'noop') {
        warnings.push(`entity ${step.entity}: from≡to (${step.from}) — no-op`)
        continue
      }

      const sourceEntity = findEntity(plan.sourceAst, step.entity)
      const destEntity = findEntity(plan.targetAst, step.entity)

      if (step.action === 'copy-global') {
        const count = await countRows(connectionString, defaultDb, destEntity.name)
        warnings.push(`global entity ${step.entity}: already in default database (no-op copy)`)
        migrated.push({ entity: step.entity, rows: count, skipped: true })
        continue
      }

      for (const tenantId of plan.tenants) {
        migrated.push(
          await moveTenantEntity(
            connectionString,
            defaultDb,
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
        await dropAfterMigrate(connectionString, defaultDb, step, plan.tenants)
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
