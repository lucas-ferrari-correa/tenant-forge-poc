import mysql from 'mysql2/promise'
import {
  type CatalogForeignKey,
  type CatalogObject,
  type CatalogSnapshot,
  DEFAULT_TENANT_NAMESPACE_PATTERN,
  isTenantNamespace,
} from './catalog.js'
import { SchemaPullError } from './errors.js'
import type { SchemaPullOptions } from './types.js'

const SYSTEM_DATABASES = new Set(['mysql', 'information_schema', 'performance_schema', 'sys'])

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

function defaultDatabaseFromUri(connectionString: string): string {
  const url = new URL(connectionString)
  const path = url.pathname.replace(/^\//, '')
  return path.length > 0 ? path : 'mysql'
}

async function listDatabases(
  connection: mysql.Connection,
  pattern: RegExp,
  defaultDb: string,
): Promise<{ tenant: string[]; allUser: string[] }> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>('SHOW DATABASES')
  const names = (rows as Array<{ Database: string }>).map((row) => row.Database)
  const allUser = names.filter((name) => !SYSTEM_DATABASES.has(name))
  const tenant = allUser
    .filter((name) => isTenantNamespace(name, pattern) && name !== defaultDb)
    .sort()
  return { tenant, allUser }
}

async function loadColumns(
  connection: mysql.Connection,
  database: string,
  table: string,
): Promise<CatalogObject['columns']> {
  const [cols] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT COLUMN_NAME AS column_name,
            COLUMN_TYPE AS column_type,
            DATA_TYPE AS data_type,
            IS_NULLABLE AS is_nullable,
            COLUMN_KEY AS column_key
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [database, table],
  )

  return (
    cols as Array<{
      column_name: string
      column_type: string
      data_type: string
      is_nullable: string
      column_key: string
    }>
  ).map((row) => ({
    name: row.column_name,
    // Prefer COLUMN_TYPE for TINYINT(1) boolean detection
    nativeType: row.column_type || row.data_type,
    nullable: row.is_nullable === 'YES',
    isPrimaryKey: row.column_key === 'PRI',
    isUnique: row.column_key === 'UNI' ? true : undefined,
  }))
}

async function loadForeignKeys(
  connection: mysql.Connection,
  database: string,
  table: string,
): Promise<CatalogForeignKey[]> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT
       CONSTRAINT_NAME AS constraint_name,
       COLUMN_NAME AS column_name,
       REFERENCED_TABLE_SCHEMA AS referenced_schema,
       REFERENCED_TABLE_NAME AS referenced_table,
       REFERENCED_COLUMN_NAME AS referenced_column,
       ORDINAL_POSITION AS ordinal_position
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
       AND REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION`,
    [database, table],
  )

  const grouped = new Map<string, CatalogForeignKey>()
  for (const row of rows as Array<{
    constraint_name: string
    column_name: string
    referenced_schema: string
    referenced_table: string
    referenced_column: string
  }>) {
    const existing = grouped.get(row.constraint_name)
    if (existing === undefined) {
      grouped.set(row.constraint_name, {
        constraintName: row.constraint_name,
        columns: [row.column_name],
        referencedTable: row.referenced_table,
        referencedColumns: [row.referenced_column],
        referencedNamespace: row.referenced_schema,
      })
    } else {
      existing.columns.push(row.column_name)
      existing.referencedColumns.push(row.referenced_column)
    }
  }
  return [...grouped.values()]
}

async function introspectDatabaseTables(
  connection: mysql.Connection,
  database: string,
  namespaceKind: CatalogObject['namespaceKind'],
): Promise<CatalogObject[]> {
  const [tables] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME AS name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [database],
  )

  const objects: CatalogObject[] = []
  for (const row of tables as Array<{ name: string }>) {
    const columns = await loadColumns(connection, database, row.name)
    const foreignKeys = await loadForeignKeys(connection, database, row.name)
    objects.push({
      name: row.name,
      namespace: database,
      namespaceKind,
      columns,
      foreignKeys,
      kind: 'table',
    })
  }
  return objects
}

/**
 * Introspect MySQL: default DB + tenant_* databases.
 * Bridge×silo share DB≈namespace — inference requires assumeTenancy/entityTenancy.
 */
export async function introspectMysqlCatalog(
  connectionString: string,
  options?: SchemaPullOptions,
): Promise<CatalogSnapshot> {
  const pattern = options?.tenantNamespacePattern ?? DEFAULT_TENANT_NAMESPACE_PATTERN
  const defaultNamespace = defaultDatabaseFromUri(connectionString)

  try {
    return await withConnection(connectionString, async (connection) => {
      const { tenant: tenantDatabases } = await listDatabases(connection, pattern, defaultNamespace)

      const objects: CatalogObject[] = []
      objects.push(...(await introspectDatabaseTables(connection, defaultNamespace, 'default')))

      for (const databaseName of tenantDatabases) {
        objects.push(
          ...(await introspectDatabaseTables(connection, databaseName, 'tenant-database')),
        )
      }

      return {
        dialect: 'mysql',
        defaultNamespace,
        objects,
        tenantSchemas: [],
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
