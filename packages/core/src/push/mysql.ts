import mysql from 'mysql2/promise'
import type { EntityDefinition } from '../ast/types.js'
import {
  compileCreateTableSql,
  compileForeignKeySql,
  compileTenantIdIndexSql,
  quoteSqlIdent,
  relationsWithForeignKeys,
} from './ddl.js'
import { SchemaPushError } from './errors.js'
import { assertSafeIdent, tenantNamespace } from './naming.js'
import { entitiesForModel } from './plan.js'
import type { SchemaPushCreatedObject, SchemaPushPlan, SchemaPushResult } from './types.js'

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

async function ensureDatabase(
  connection: mysql.Connection,
  databaseName: string,
  created: SchemaPushCreatedObject[],
  tenancyModel: SchemaPushCreatedObject['tenancyModel'],
): Promise<void> {
  assertSafeIdent(databaseName)
  await connection.query(`CREATE DATABASE IF NOT EXISTS ${quoteSqlIdent('mysql', databaseName)}`)
  created.push({ kind: 'database', name: databaseName, tenancyModel })
}

function qualifyTable(database: string | undefined, tableName: string): string {
  const table = quoteSqlIdent('mysql', tableName)
  if (database === undefined) {
    return table
  }
  return `${quoteSqlIdent('mysql', database)}.${table}`
}

async function createEntityTable(
  connection: mysql.Connection,
  entity: EntityDefinition,
  opts: {
    database?: string
    model: SchemaPushCreatedObject['tenancyModel']
    created: SchemaPushCreatedObject[]
  },
): Promise<void> {
  const qualified = qualifyTable(opts.database, entity.name)
  const ddl = compileCreateTableSql('mysql', qualified, entity.fields)
  await connection.query(ddl)
  opts.created.push({
    kind: 'table',
    name: entity.name,
    namespace: opts.database,
    tenancyModel: opts.model,
  })

  if (opts.model === 'shared-db-shared-schema') {
    const indexSql = compileTenantIdIndexSql('mysql', entity.name, qualified)
    try {
      await connection.query(indexSql)
      opts.created.push({
        kind: 'index',
        name: `${entity.name}_tenant_id_idx`,
        namespace: opts.database,
        tenancyModel: opts.model,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // ER_DUP_KEYNAME — idempotent re-push
      if (!/Duplicate key name/i.test(message)) {
        throw new SchemaPushError('EXECUTION_FAILED', message)
      }
    }
  }
}

async function addForeignKeys(
  connection: mysql.Connection,
  entities: EntityDefinition[],
  qualifyTarget: (entityName: string) => string,
  qualifySource: (entityName: string) => string,
  warnings: string[],
): Promise<void> {
  for (const entity of entities) {
    for (const relation of relationsWithForeignKeys(entity.relations)) {
      const targetExists = entities.some((candidate) => candidate.name === relation.target)
      if (!targetExists) {
        warnings.push(
          `skipped FK ${entity.name}.${relation.name}: target entity ${relation.target} not in same namespace`,
        )
        continue
      }
      const sql = compileForeignKeySql(
        'mysql',
        entity.name,
        qualifySource(entity.name),
        relation,
        qualifyTarget(relation.target),
      )
      try {
        await connection.query(sql)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/Duplicate foreign key|already exists/i.test(message)) {
          throw new SchemaPushError('EXECUTION_FAILED', message)
        }
      }
    }
  }
}

/**
 * Forward-engineer MySQL layout from a push plan.
 * Bridge uses database ≈ schema (pool-safe qualify, same as adapter).
 * No RLS — isolation is column + app/IR filter.
 */
export async function pushMysqlSchema(
  connectionString: string,
  plan: SchemaPushPlan,
): Promise<SchemaPushResult> {
  const created: SchemaPushCreatedObject[] = []
  const warnings: string[] = []

  const poolEntities = entitiesForModel(plan, 'shared-db-shared-schema').map((e) => e.entity)
  const bridgeEntities = entitiesForModel(plan, 'shared-db-isolated-schema').map((e) => e.entity)
  const siloEntities = entitiesForModel(plan, 'single-tenant').map((e) => e.entity)
  const globalEntities = entitiesForModel(plan, 'global').map((e) => e.entity)

  // MySQL: bridge and silo both use database-per-tenant naming (`tenant_${slug}`).
  // When both models appear (hybrid), they share the same DB names — tables coexist.
  const namespaceTenants = new Set<string>()
  if (bridgeEntities.length > 0 || siloEntities.length > 0) {
    for (const tenantId of plan.tenants) {
      namespaceTenants.add(tenantNamespace(tenantId))
    }
  }

  await withConnection(connectionString, async (connection) => {
    for (const databaseName of namespaceTenants) {
      const model =
        bridgeEntities.length > 0 && siloEntities.length > 0
          ? undefined
          : bridgeEntities.length > 0
            ? 'shared-db-isolated-schema'
            : 'single-tenant'
      await ensureDatabase(connection, databaseName, created, model)
    }

    for (const entity of poolEntities) {
      await createEntityTable(connection, entity, {
        model: 'shared-db-shared-schema',
        created,
      })
    }
    for (const entity of globalEntities) {
      await createEntityTable(connection, entity, {
        model: 'global',
        created,
      })
    }
    await addForeignKeys(
      connection,
      [...poolEntities, ...globalEntities],
      (name) => quoteSqlIdent('mysql', name),
      (name) => quoteSqlIdent('mysql', name),
      warnings,
    )

    for (const tenantId of plan.tenants) {
      const databaseName = tenantNamespace(tenantId)
      for (const entity of bridgeEntities) {
        await createEntityTable(connection, entity, {
          database: databaseName,
          model: 'shared-db-isolated-schema',
          created,
        })
      }
      if (bridgeEntities.length > 0) {
        await addForeignKeys(
          connection,
          bridgeEntities,
          (name) => qualifyTable(databaseName, name),
          (name) => qualifyTable(databaseName, name),
          warnings,
        )
      }
      for (const entity of siloEntities) {
        await createEntityTable(connection, entity, {
          database: databaseName,
          model: 'single-tenant',
          created,
        })
      }
      if (siloEntities.length > 0) {
        await addForeignKeys(
          connection,
          siloEntities,
          (name) => qualifyTable(databaseName, name),
          (name) => qualifyTable(databaseName, name),
          warnings,
        )
      }
    }
  })

  return { dialect: 'mysql', created, warnings }
}
