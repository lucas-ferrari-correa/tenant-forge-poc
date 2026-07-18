import { type Document, MongoClient } from 'mongodb'
import {
  type CatalogObject,
  type CatalogSnapshot,
  DEFAULT_TENANT_NAMESPACE_PATTERN,
  isTenantNamespace,
} from './catalog.js'
import { SchemaPullError } from './errors.js'
import { inferBsonType } from './map-types.js'
import type { SchemaPullOptions } from './types.js'

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config'])
const SAMPLE_LIMIT = 50

function defaultDatabaseFromUri(connectionString: string): string {
  const url = new URL(connectionString)
  const path = url.pathname.replace(/^\//, '')
  return path.length > 0 ? path : 'test'
}

function mergeFieldTypes(
  acc: Map<string, { nativeType: string; nullable: boolean }>,
  doc: Document,
): void {
  for (const [key, value] of Object.entries(doc)) {
    const nativeType = inferBsonType(value)
    const existing = acc.get(key)
    if (existing === undefined) {
      acc.set(key, { nativeType, nullable: value === null || value === undefined })
      continue
    }
    if (value === null || value === undefined) {
      existing.nullable = true
    } else if (existing.nativeType === 'null') {
      existing.nativeType = nativeType
    }
  }
}

async function introspectCollection(
  client: MongoClient,
  databaseName: string,
  collectionName: string,
  namespaceKind: CatalogObject['namespaceKind'],
): Promise<CatalogObject> {
  const collection = client.db(databaseName).collection(collectionName)
  const fieldMap = new Map<string, { nativeType: string; nullable: boolean }>()

  const samples = await collection.find({}).limit(SAMPLE_LIMIT).toArray()
  for (const doc of samples) {
    mergeFieldTypes(fieldMap, doc)
  }

  // Index keys can reveal fields (e.g. tenant_id) even on empty collections.
  const indexes = await collection.indexes()
  let hasTenantIdIndex = false
  for (const index of indexes) {
    const key = index.key as Record<string, unknown>
    for (const fieldName of Object.keys(key)) {
      if (fieldName === '_id') {
        continue
      }
      if (fieldName === 'tenant_id') {
        hasTenantIdIndex = true
      }
      if (!fieldMap.has(fieldName)) {
        fieldMap.set(fieldName, { nativeType: 'string', nullable: false })
      }
    }
  }

  if (fieldMap.size === 0) {
    fieldMap.set('id', { nativeType: 'string', nullable: false })
  }

  // Prefer application `id` as PK when present; else _id.
  const hasId = fieldMap.has('id')
  const columns: CatalogObject['columns'] = []

  for (const [name, meta] of fieldMap) {
    if (name === '_id' && hasId) {
      continue
    }
    const fieldName = name === '_id' ? 'id' : name
    columns.push({
      name: fieldName,
      nativeType: meta.nativeType,
      nullable: meta.nullable,
      isPrimaryKey: fieldName === 'id' || (name === '_id' && !hasId),
    })
  }

  // Ensure tenant_id marked when only known via index
  if (hasTenantIdIndex && !columns.some((c) => c.name === 'tenant_id')) {
    columns.push({
      name: 'tenant_id',
      nativeType: 'string',
      nullable: false,
      isPrimaryKey: false,
    })
  }

  return {
    name: collectionName,
    namespace: databaseName,
    namespaceKind,
    columns,
    foreignKeys: [],
    kind: 'collection',
  }
}

async function listCollections(
  client: MongoClient,
  databaseName: string,
  namespaceKind: CatalogObject['namespaceKind'],
): Promise<CatalogObject[]> {
  const names = await client.db(databaseName).listCollections().toArray()
  const objects: CatalogObject[] = []
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
    // Skip system collections
    if (entry.name.startsWith('system.')) {
      continue
    }
    objects.push(await introspectCollection(client, databaseName, entry.name, namespaceKind))
  }
  return objects
}

/**
 * Introspect MongoDB: default DB + tenant_* databases.
 * No FK inference. Empty collections rely on indexes + synthesized id.
 * Bridge×silo ambiguous — requires assumeTenancy/entityTenancy.
 */
export async function introspectMongodbCatalog(
  connectionString: string,
  options?: SchemaPullOptions,
): Promise<CatalogSnapshot> {
  const pattern = options?.tenantNamespacePattern ?? DEFAULT_TENANT_NAMESPACE_PATTERN
  const defaultNamespace = defaultDatabaseFromUri(connectionString)
  const client = new MongoClient(connectionString)

  try {
    await client.connect()
    const admin = client.db().admin()
    const { databases } = await admin.listDatabases()
    const tenantDatabases = databases
      .map((db) => db.name)
      .filter(
        (name) =>
          !SYSTEM_DATABASES.has(name) &&
          isTenantNamespace(name, pattern) &&
          name !== defaultNamespace,
      )
      .sort()

    const objects: CatalogObject[] = []
    objects.push(...(await listCollections(client, defaultNamespace, 'default')))

    for (const databaseName of tenantDatabases) {
      objects.push(...(await listCollections(client, databaseName, 'tenant-database')))
    }

    return {
      dialect: 'mongodb',
      defaultNamespace,
      objects,
      tenantSchemas: [],
      tenantDatabases,
    }
  } catch (error) {
    if (error instanceof SchemaPullError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new SchemaPullError('EXECUTION_FAILED', message)
  } finally {
    await client.close()
  }
}
