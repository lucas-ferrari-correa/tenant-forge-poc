import { MongoClient } from 'mongodb'
import type { EntityDefinition } from '../ast/types.js'
import { SchemaPushError } from './errors.js'
import { assertSafeIdent, siloNamespace, tenantNamespace } from './naming.js'
import { entitiesForModel } from './plan.js'
import type { SchemaPushCreatedObject, SchemaPushPlan, SchemaPushResult } from './types.js'

function defaultDatabaseFromUri(connectionString: string): string {
  const url = new URL(connectionString)
  const path = url.pathname.replace(/^\//, '')
  return path.length > 0 ? path : 'test'
}

async function ensureCollection(
  client: MongoClient,
  databaseName: string,
  entity: EntityDefinition,
  model: SchemaPushCreatedObject['tenancyModel'],
  created: SchemaPushCreatedObject[],
): Promise<void> {
  assertSafeIdent(entity.name)
  assertSafeIdent(databaseName)
  const db = client.db(databaseName)
  const existing = await db.listCollections({ name: entity.name }).toArray()
  if (existing.length === 0) {
    await db.createCollection(entity.name)
  }
  created.push({
    kind: 'collection',
    name: entity.name,
    namespace: databaseName,
    tenancyModel: model,
  })

  if (model === 'shared-db-shared-schema') {
    const indexName = `${entity.name}_tenant_id_idx`
    await db.collection(entity.name).createIndex({ tenant_id: 1 }, { name: indexName })
    created.push({
      kind: 'index',
      name: indexName,
      namespace: databaseName,
      tenancyModel: model,
    })
  }
}

/**
 * Forward-engineer MongoDB layout from a push plan.
 * Bridge → database `tenant_${slug}`; silo → database `silo_${slug}` (distinct namespaces).
 * No FK constraints — relations degrade to documented warnings.
 */
export async function pushMongodbSchema(
  connectionString: string,
  plan: SchemaPushPlan,
): Promise<SchemaPushResult> {
  const created: SchemaPushCreatedObject[] = []
  const warnings: string[] = [
    'MongoDB has no foreign-key constraints; relations are application-level only (ODM degradation).',
  ]

  const poolEntities = entitiesForModel(plan, 'shared-db-shared-schema').map((e) => e.entity)
  const bridgeEntities = entitiesForModel(plan, 'shared-db-isolated-schema').map((e) => e.entity)
  const siloEntities = entitiesForModel(plan, 'single-tenant').map((e) => e.entity)
  const globalEntities = entitiesForModel(plan, 'global').map((e) => e.entity)

  for (const entity of [...poolEntities, ...bridgeEntities, ...siloEntities, ...globalEntities]) {
    if ((entity.relations?.length ?? 0) > 0) {
      warnings.push(
        `entity ${entity.name}: relation(s) declared but Mongo push does not create referential constraints`,
      )
    }
  }

  const defaultDb = defaultDatabaseFromUri(connectionString)
  const client = new MongoClient(connectionString)

  try {
    await client.connect()

    for (const entity of poolEntities) {
      await ensureCollection(client, defaultDb, entity, 'shared-db-shared-schema', created)
    }
    for (const entity of globalEntities) {
      await ensureCollection(client, defaultDb, entity, 'global', created)
    }

    // Bridge → database `tenant_${slug}`; silo → database `silo_${slug}` (distinct).
    for (const tenantId of plan.tenants) {
      if (bridgeEntities.length > 0) {
        const databaseName = tenantNamespace(tenantId)
        created.push({
          kind: 'database',
          name: databaseName,
          tenancyModel: 'shared-db-isolated-schema',
        })
        for (const entity of bridgeEntities) {
          await ensureCollection(client, databaseName, entity, 'shared-db-isolated-schema', created)
        }
      }
      if (siloEntities.length > 0) {
        const databaseName = siloNamespace(tenantId)
        created.push({
          kind: 'database',
          name: databaseName,
          tenancyModel: 'single-tenant',
        })
        for (const entity of siloEntities) {
          await ensureCollection(client, databaseName, entity, 'single-tenant', created)
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new SchemaPushError('EXECUTION_FAILED', message)
  } finally {
    await client.close()
  }

  return { dialect: 'mongodb', created, warnings }
}
