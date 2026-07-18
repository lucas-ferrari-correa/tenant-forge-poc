import pg from 'pg'
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

async function databaseExists(client: pg.Client, name: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
  return (result.rowCount ?? 0) > 0
}

async function ensureDatabase(
  adminConnectionString: string,
  databaseName: string,
  created: SchemaPushCreatedObject[],
  tenancyModel: SchemaPushCreatedObject['tenancyModel'],
): Promise<void> {
  assertSafeIdent(databaseName)
  await withClient(adminConnectionString, async (client) => {
    const exists = await databaseExists(client, databaseName)
    if (!exists) {
      // CREATE DATABASE cannot run inside a transaction / prepared statement.
      await client.query(`CREATE DATABASE ${quoteSqlIdent('postgres', databaseName)}`)
      created.push({ kind: 'database', name: databaseName, tenancyModel })
    }
  })
}

async function ensureSchema(
  client: pg.Client,
  schemaName: string,
  created: SchemaPushCreatedObject[],
): Promise<void> {
  assertSafeIdent(schemaName)
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteSqlIdent('postgres', schemaName)}`)
  created.push({
    kind: 'schema',
    name: schemaName,
    tenancyModel: 'shared-db-isolated-schema',
  })
}

function qualifyTable(schema: string | undefined, tableName: string): string {
  const table = quoteSqlIdent('postgres', tableName)
  if (schema === undefined) {
    return table
  }
  return `${quoteSqlIdent('postgres', schema)}.${table}`
}

async function createEntityTable(
  client: pg.Client,
  entity: EntityDefinition,
  opts: {
    schema?: string
    model: SchemaPushCreatedObject['tenancyModel']
    withRls: boolean
    rlsSessionVar: string
    created: SchemaPushCreatedObject[]
  },
): Promise<void> {
  const qualified = qualifyTable(opts.schema, entity.name)
  const ddl = compileCreateTableSql('postgres', qualified, entity.fields)
  await client.query(ddl)
  opts.created.push({
    kind: 'table',
    name: entity.name,
    namespace: opts.schema,
    tenancyModel: opts.model,
  })

  if (opts.model === 'shared-db-shared-schema') {
    const indexSql = compileTenantIdIndexSql('postgres', entity.name, qualified)
    await client.query(indexSql)
    opts.created.push({
      kind: 'index',
      name: `${entity.name}_tenant_id_idx`,
      namespace: opts.schema,
      tenancyModel: opts.model,
    })
  }

  if (opts.withRls) {
    await client.query(`ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY`)
    await client.query(`ALTER TABLE ${qualified} FORCE ROW LEVEL SECURITY`)
    opts.created.push({
      kind: 'rls',
      name: entity.name,
      namespace: opts.schema,
      tenancyModel: opts.model,
    })

    const policyName = quoteSqlIdent('postgres', `${entity.name}_tenant_isolation`)
    const tenantCol = quoteSqlIdent('postgres', 'tenant_id')
    // Drop+create for idempotency (CREATE POLICY has no IF NOT EXISTS on older PG).
    await client.query(`DROP POLICY IF EXISTS ${policyName} ON ${qualified}`)
    await client.query(
      `CREATE POLICY ${policyName} ON ${qualified}
        FOR ALL
        USING (${tenantCol} = current_setting('${opts.rlsSessionVar}', true))
        WITH CHECK (${tenantCol} = current_setting('${opts.rlsSessionVar}', true))`,
    )
    opts.created.push({
      kind: 'policy',
      name: `${entity.name}_tenant_isolation`,
      namespace: opts.schema,
      tenancyModel: opts.model,
    })
  }
}

async function addForeignKeys(
  client: pg.Client,
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
        'postgres',
        entity.name,
        qualifySource(entity.name),
        relation,
        qualifyTarget(relation.target),
      )
      try {
        await client.query(sql)
      } catch (error) {
        // Idempotent re-push: constraint may already exist.
        const message = error instanceof Error ? error.message : String(error)
        if (!/already exists/i.test(message)) {
          throw new SchemaPushError('EXECUTION_FAILED', message)
        }
      }
    }
  }
}

/**
 * Forward-engineer Postgres layout from a push plan.
 */
export async function pushPostgresSchema(
  connectionString: string,
  plan: SchemaPushPlan,
): Promise<SchemaPushResult> {
  const created: SchemaPushCreatedObject[] = []
  const warnings: string[] = []

  const poolEntities = entitiesForModel(plan, 'shared-db-shared-schema').map((e) => e.entity)
  const bridgeEntities = entitiesForModel(plan, 'shared-db-isolated-schema').map((e) => e.entity)
  const siloEntities = entitiesForModel(plan, 'single-tenant').map((e) => e.entity)
  const globalEntities = entitiesForModel(plan, 'global').map((e) => e.entity)

  // --- pool + global (default database) ---
  await withClient(connectionString, async (client) => {
    for (const entity of poolEntities) {
      await createEntityTable(client, entity, {
        model: 'shared-db-shared-schema',
        withRls: true,
        rlsSessionVar: plan.rlsSessionVar,
        created,
      })
    }
    for (const entity of globalEntities) {
      await createEntityTable(client, entity, {
        model: 'global',
        withRls: false,
        rlsSessionVar: plan.rlsSessionVar,
        created,
      })
    }
    await addForeignKeys(
      client,
      [...poolEntities, ...globalEntities],
      (name) => quoteSqlIdent('postgres', name),
      (name) => quoteSqlIdent('postgres', name),
      warnings,
    )
  })

  // --- bridge: schema-per-tenant (no tenant_id) ---
  if (bridgeEntities.length > 0) {
    await withClient(connectionString, async (client) => {
      for (const tenantId of plan.tenants) {
        const schemaName = tenantNamespace(tenantId)
        await ensureSchema(client, schemaName, created)
        for (const entity of bridgeEntities) {
          await createEntityTable(client, entity, {
            schema: schemaName,
            model: 'shared-db-isolated-schema',
            withRls: false,
            rlsSessionVar: plan.rlsSessionVar,
            created,
          })
        }
        await addForeignKeys(
          client,
          bridgeEntities,
          (name) => qualifyTable(schemaName, name),
          (name) => qualifyTable(schemaName, name),
          warnings,
        )
      }
    })
  }

  // --- silo: database-per-tenant ---
  if (siloEntities.length > 0) {
    for (const tenantId of plan.tenants) {
      const databaseName = tenantNamespace(tenantId)
      await ensureDatabase(connectionString, databaseName, created, 'single-tenant')
      const siloUrl = rewriteDatabase(connectionString, databaseName)
      await withClient(siloUrl, async (client) => {
        for (const entity of siloEntities) {
          await createEntityTable(client, entity, {
            model: 'single-tenant',
            withRls: false,
            rlsSessionVar: plan.rlsSessionVar,
            created,
          })
        }
        await addForeignKeys(
          client,
          siloEntities,
          (name) => quoteSqlIdent('postgres', name),
          (name) => quoteSqlIdent('postgres', name),
          warnings,
        )
      })
    }
  }

  return { dialect: 'postgres', created, warnings }
}
