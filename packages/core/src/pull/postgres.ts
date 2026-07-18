import pg from 'pg'
import {
  type CatalogForeignKey,
  type CatalogObject,
  type CatalogSnapshot,
  DEFAULT_TENANT_NAMESPACE_PATTERN,
  isTenantNamespace,
} from './catalog.js'
import { SchemaPullError } from './errors.js'
import type { SchemaPullOptions } from './types.js'

const { Client } = pg

const SYSTEM_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'pg_toast'])
const SYSTEM_DATABASES = new Set(['postgres', 'template0', 'template1'])

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

function defaultDatabaseFromUri(connectionString: string): string {
  const url = new URL(connectionString)
  const path = url.pathname.replace(/^\//, '')
  return path.length > 0 ? path : 'postgres'
}

async function listTenantDatabases(client: pg.Client, pattern: RegExp): Promise<string[]> {
  const result = await client.query<{ datname: string }>(
    `SELECT datname FROM pg_database WHERE datistemplate = false`,
  )
  return result.rows
    .map((row) => row.datname)
    .filter((name) => !SYSTEM_DATABASES.has(name) && isTenantNamespace(name, pattern))
    .sort()
}

async function listUserSchemas(
  client: pg.Client,
  pattern: RegExp,
): Promise<{
  all: string[]
  tenant: string[]
}> {
  const result = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'`,
  )
  const all = result.rows.map((row) => row.nspname).filter((name) => !SYSTEM_SCHEMAS.has(name))
  const tenant = all.filter((name) => isTenantNamespace(name, pattern)).sort()
  return { all, tenant }
}

async function loadColumns(
  client: pg.Client,
  schema: string,
  table: string,
): Promise<CatalogObject['columns']> {
  const cols = await client.query<{
    column_name: string
    data_type: string
    udt_name: string
    is_nullable: string
  }>(
    `SELECT column_name, data_type, udt_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, table],
  )

  const pk = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = $1 AND tc.table_name = $2`,
    [schema, table],
  )
  const pkSet = new Set(pk.rows.map((row) => row.column_name))

  const unique = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'UNIQUE'
       AND tc.table_schema = $1 AND tc.table_name = $2`,
    [schema, table],
  )
  const uniqueSet = new Set(unique.rows.map((row) => row.column_name))

  return cols.rows.map((row) => {
    const native =
      row.data_type === 'USER-DEFINED' || row.data_type === 'ARRAY' ? row.udt_name : row.data_type
    return {
      name: row.column_name,
      nativeType: native,
      nullable: row.is_nullable === 'YES',
      isPrimaryKey: pkSet.has(row.column_name),
      isUnique: uniqueSet.has(row.column_name) ? true : undefined,
    }
  })
}

async function loadForeignKeys(
  client: pg.Client,
  schema: string,
  table: string,
): Promise<CatalogForeignKey[]> {
  const result = await client.query<{
    constraint_name: string
    column_name: string
    foreign_table_schema: string
    foreign_table_name: string
    foreign_column_name: string
    ordinal_position: number
  }>(
    `SELECT
       tc.constraint_name,
       kcu.column_name,
       ccu.table_schema AS foreign_table_schema,
       ccu.table_name AS foreign_table_name,
       ccu.column_name AS foreign_column_name,
       kcu.ordinal_position
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema = $1 AND tc.table_name = $2
     ORDER BY tc.constraint_name, kcu.ordinal_position`,
    [schema, table],
  )

  const grouped = new Map<string, CatalogForeignKey>()
  for (const row of result.rows) {
    const existing = grouped.get(row.constraint_name)
    if (existing === undefined) {
      grouped.set(row.constraint_name, {
        constraintName: row.constraint_name,
        columns: [row.column_name],
        referencedTable: row.foreign_table_name,
        referencedColumns: [row.foreign_column_name],
        referencedNamespace: row.foreign_table_schema,
      })
    } else {
      existing.columns.push(row.column_name)
      existing.referencedColumns.push(row.foreign_column_name)
    }
  }
  return [...grouped.values()]
}

async function loadRlsFlags(
  client: pg.Client,
  schema: string,
  table: string,
  rlsSessionVar: string,
): Promise<{ rlsEnabled: boolean; rlsTenantPolicy: boolean }> {
  const rel = await client.query<{ relrowsecurity: boolean }>(
    `SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
    [schema, table],
  )
  const rlsEnabled = rel.rows[0]?.relrowsecurity === true

  if (!rlsEnabled) {
    return { rlsEnabled: false, rlsTenantPolicy: false }
  }

  const policies = await client.query<{ qual: string | null; with_check: string | null }>(
    `SELECT pg_get_expr(polqual, polrelid) AS qual,
            pg_get_expr(polwithcheck, polrelid) AS with_check
     FROM pg_policy pol
     JOIN pg_class c ON c.oid = pol.polrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, table],
  )

  const needle = `current_setting('${rlsSessionVar}'`
  const rlsTenantPolicy = policies.rows.some((row) => {
    const text = `${row.qual ?? ''} ${row.with_check ?? ''}`
    return text.includes(needle)
  })

  return { rlsEnabled, rlsTenantPolicy }
}

async function introspectSchemaTables(
  client: pg.Client,
  schema: string,
  namespaceKind: CatalogObject['namespaceKind'],
  rlsSessionVar: string,
): Promise<CatalogObject[]> {
  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
    [schema],
  )

  const objects: CatalogObject[] = []
  for (const row of tables.rows) {
    const columns = await loadColumns(client, schema, row.tablename)
    const foreignKeys = await loadForeignKeys(client, schema, row.tablename)
    const rls =
      namespaceKind === 'default'
        ? await loadRlsFlags(client, schema, row.tablename, rlsSessionVar)
        : { rlsEnabled: false, rlsTenantPolicy: false }

    objects.push({
      name: row.tablename,
      namespace: schema,
      namespaceKind,
      columns,
      foreignKeys,
      kind: 'table',
      rlsEnabled: rls.rlsEnabled,
      rlsTenantPolicy: rls.rlsTenantPolicy,
    })
  }
  return objects
}

/**
 * Introspect Postgres: public + tenant_* schemas in connection DB, plus tenant_* databases.
 */
export async function introspectPostgresCatalog(
  connectionString: string,
  options?: SchemaPullOptions,
): Promise<CatalogSnapshot> {
  const pattern = options?.tenantNamespacePattern ?? DEFAULT_TENANT_NAMESPACE_PATTERN
  const rlsSessionVar = options?.rlsSessionVar ?? 'app.current_tenant_id'
  const defaultNamespace = 'public'
  const defaultDb = defaultDatabaseFromUri(connectionString)

  try {
    return await withClient(connectionString, async (client) => {
      const { tenant: tenantSchemas } = await listUserSchemas(client, pattern)
      const tenantDatabases = (await listTenantDatabases(client, pattern)).filter(
        (name) => name !== defaultDb,
      )

      const objects: CatalogObject[] = []

      // Default schema (public)
      objects.push(
        ...(await introspectSchemaTables(client, defaultNamespace, 'default', rlsSessionVar)),
      )

      // Bridge: tenant_* schemas in the same database
      for (const schema of tenantSchemas) {
        objects.push(
          ...(await introspectSchemaTables(client, schema, 'tenant-schema', rlsSessionVar)),
        )
      }

      // Silo: tenant_* databases (public schema of each)
      for (const databaseName of tenantDatabases) {
        const siloObjects = await withClient(
          rewriteDatabase(connectionString, databaseName),
          async (siloClient) =>
            introspectSchemaTables(siloClient, 'public', 'tenant-database', rlsSessionVar),
        )
        for (const object of siloObjects) {
          objects.push({
            ...object,
            namespace: databaseName,
            namespaceKind: 'tenant-database',
          })
        }
      }

      return {
        dialect: 'postgres',
        defaultNamespace,
        objects,
        tenantSchemas,
        tenantDatabases,
      }
    })
  } catch (error) {
    if (error instanceof SchemaPullError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new SchemaPullError('EXECUTION_FAILED', message)
  }
}
