/** Intermediate catalog from dialect introspection — input to tenancy inference + AST build. */

export type CatalogNamespaceKind = 'default' | 'tenant-schema' | 'tenant-database' | 'silo-database'

export type CatalogColumn = {
  name: string
  nativeType: string
  nullable: boolean
  isPrimaryKey: boolean
  isUnique?: boolean
}

export type CatalogForeignKey = {
  constraintName: string
  columns: string[]
  referencedTable: string
  referencedColumns: string[]
  referencedNamespace: string
}

export type CatalogObject = {
  name: string
  namespace: string
  namespaceKind: CatalogNamespaceKind
  columns: CatalogColumn[]
  foreignKeys: CatalogForeignKey[]
  kind: 'table' | 'collection'
  /** Postgres: table has RLS enabled. */
  rlsEnabled?: boolean
  /** Postgres: policy matches current_setting(rlsSessionVar). */
  rlsTenantPolicy?: boolean
}

export type CatalogSnapshot = {
  dialect: 'postgres' | 'mysql' | 'mongodb'
  defaultNamespace: string
  objects: CatalogObject[]
  /** tenant_* schemas in the connection database (Postgres). */
  tenantSchemas: string[]
  /** tenant_* databases on the server. */
  tenantDatabases: string[]
}

export const DEFAULT_TENANT_NAMESPACE_PATTERN = /^tenant_/

/** Silo databases carry a dedicated prefix, distinct from bridge (`tenant_`). */
export const DEFAULT_SILO_NAMESPACE_PATTERN = /^silo_/

export function isTenantNamespace(name: string, pattern: RegExp): boolean {
  return pattern.test(name)
}

export function hasTenantIdColumn(columns: CatalogColumn[]): boolean {
  return columns.some((column) => column.name === 'tenant_id')
}
