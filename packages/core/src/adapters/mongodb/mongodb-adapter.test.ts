import { MongoClient } from 'mongodb'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildQuery,
  CONTAINER_IMAGES,
  createMongodbAdapter,
  createTenantContext,
  defineSchema,
  type EntityDefinition,
  type MongodbAdapter,
  type SchemaAst,
} from '../../index.js'

const MONGO_DB = 'tenant_forge'

function idField(): EntityDefinition['fields'][number] {
  return { name: 'id', type: 'String', primaryKey: true }
}

function tenantIdField(): EntityDefinition['fields'][number] {
  return { name: 'tenant_id', type: 'String', isTenantId: true }
}

function taskEntity(opts: {
  withTenantId?: boolean
  global?: boolean
  name?: string
}): EntityDefinition {
  const fields = [idField(), { name: 'title', type: 'String' as const }]
  if (opts.withTenantId === true) {
    fields.push(tenantIdField())
  }
  return {
    name: opts.name ?? 'Task',
    fields,
    ...(opts.global !== undefined ? { global: opts.global } : {}),
  }
}

function ctx(tenantId: string) {
  return createTenantContext({ tenantId, source: 'jwt-claim' })
}

async function withAdmin<T>(
  connectionString: string,
  fn: (client: MongoClient) => Promise<T>,
): Promise<T> {
  const client = new MongoClient(connectionString)
  try {
    await client.connect()
    return await fn(client)
  } finally {
    await client.close()
  }
}

async function waitForMongodb(connectionString: string): Promise<void> {
  const deadline = Date.now() + 90_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await withAdmin(connectionString, async (client) => {
        await client.db('admin').command({ ping: 1 })
      })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error(`MongoDB did not become ready: ${String(lastError)}`)
}

describe('mongodb adapter — integration (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string
  let adapter: MongodbAdapter

  const poolAst: SchemaAst = defineSchema({
    name: 'pool_app',
    tenancy: { model: 'shared-db-shared-schema' },
    entities: [taskEntity({ withTenantId: true })],
  })

  const bridgeAst: SchemaAst = defineSchema({
    name: 'bridge_app',
    tenancy: { model: 'shared-db-isolated-schema' },
    entities: [taskEntity({ withTenantId: false })],
  })

  const siloAst: SchemaAst = defineSchema({
    name: 'silo_app',
    tenancy: { model: 'single-tenant' },
    entities: [taskEntity({ withTenantId: false })],
  })

  const globalAst: SchemaAst = defineSchema({
    name: 'global_app',
    tenancy: { model: 'shared-db-shared-schema' },
    entities: [
      taskEntity({ withTenantId: true }),
      {
        name: 'Country',
        global: true,
        fields: [idField(), { name: 'code', type: 'String' }],
      },
    ],
  })

  beforeAll(async () => {
    // mongo:7 emits structured JSON logs — match msg field, not legacy plain text.
    container = await new GenericContainer(CONTAINER_IMAGES.mongodb)
      .withExposedPorts(27017)
      .withStartupTimeout(180_000)
      .withWaitStrategy(Wait.forLogMessage(/"msg":"Waiting for connections"/))
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(27017)
    connectionString = `mongodb://${host}:${port}/${MONGO_DB}`
    await waitForMongodb(connectionString)
    adapter = createMongodbAdapter({ connectionString })

    await withAdmin(connectionString, async (client) => {
      // --- pool fixture: shared collection + tenant_id index (shard-key candidate) ---
      const poolDb = client.db(MONGO_DB)
      await poolDb.collection('Task').createIndex({ tenant_id: 1 })
      await poolDb.collection('Country').createIndex({ id: 1 }, { unique: true })

      // --- bridge fixture: database-per-tenant as namespace (schemaName → DB) ---
      await client.db('tenant_acme').collection('Task').createIndex({ id: 1 }, { unique: true })
      await client.db('tenant_beta').collection('Task').createIndex({ id: 1 }, { unique: true })
    })
  }, 180_000)

  afterAll(async () => {
    await adapter.dispose()
    await container.stop()
  })

  describe('pool (shared-db-shared-schema / tenant-id-filter)', () => {
    it('CRUD within tenant and never reads the other tenant (canary A≠B)', async () => {
      const irCreateA = buildQuery(poolAst, ctx('acme'), {
        operation: 'create',
        entity: 'Task',
        data: { id: 't-a1', title: 'Acme task' },
      })
      expect(irCreateA.isolation.kind).toBe('tenant-id-filter')
      if (irCreateA.isolation.kind === 'tenant-id-filter') {
        expect(irCreateA.isolation.mongo.shardKey).toBe('tenant_id')
      }
      const createdA = await adapter.execute(irCreateA)
      expect(createdA).toMatchObject({ id: 't-a1', title: 'Acme task', tenant_id: 'acme' })

      await adapter.execute(
        buildQuery(poolAst, ctx('beta'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 't-b1', title: 'Beta task' },
        }),
      )

      const foundA = await adapter.execute(
        buildQuery(poolAst, ctx('acme'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(foundA).toEqual([{ id: 't-a1', title: 'Acme task', tenant_id: 'acme' }])

      const foundB = await adapter.execute(
        buildQuery(poolAst, ctx('beta'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(foundB).toEqual([{ id: 't-b1', title: 'Beta task', tenant_id: 'beta' }])

      const leak = await adapter.execute(
        buildQuery(poolAst, ctx('acme'), {
          operation: 'findFirst',
          entity: 'Task',
          where: { id: 't-b1' },
        }),
      )
      expect(leak).toBeNull()

      const updated = await adapter.execute(
        buildQuery(poolAst, ctx('acme'), {
          operation: 'update',
          entity: 'Task',
          where: { id: 't-a1' },
          data: { title: 'Acme updated' },
        }),
      )
      expect(updated).toMatchObject({ id: 't-a1', title: 'Acme updated', tenant_id: 'acme' })

      const crossUpdate = await adapter.execute(
        buildQuery(poolAst, ctx('beta'), {
          operation: 'update',
          entity: 'Task',
          where: { id: 't-a1' },
          data: { title: 'hijack' },
        }),
      )
      expect(crossUpdate).toBeNull()

      const deleted = await adapter.execute(
        buildQuery(poolAst, ctx('beta'), {
          operation: 'delete',
          entity: 'Task',
          where: { id: 't-b1' },
        }),
      )
      expect(deleted).toMatchObject({ id: 't-b1' })

      const afterDelete = await adapter.execute(
        buildQuery(poolAst, ctx('beta'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(afterDelete).toEqual([])
    })
  })

  describe('bridge (shared-db-isolated-schema / schema-per-tenant)', () => {
    it('isolates via database namespace — tenant A never reads tenant B (canary)', async () => {
      const irCreate = buildQuery(bridgeAst, ctx('acme'), {
        operation: 'create',
        entity: 'Task',
        data: { id: 'br-a1', title: 'Acme bridge' },
      })
      expect(irCreate.isolation).toEqual({
        kind: 'schema-per-tenant',
        tenantId: 'acme',
        schemaName: 'tenant_acme',
      })
      expect(irCreate.where).not.toHaveProperty('tenant_id')

      await adapter.execute(irCreate)
      await adapter.execute(
        buildQuery(bridgeAst, ctx('beta'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 'br-b1', title: 'Beta bridge' },
        }),
      )

      const acmeRows = await adapter.execute(
        buildQuery(bridgeAst, ctx('acme'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(acmeRows).toEqual([{ id: 'br-a1', title: 'Acme bridge' }])

      const betaRows = await adapter.execute(
        buildQuery(bridgeAst, ctx('beta'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(betaRows).toEqual([{ id: 'br-b1', title: 'Beta bridge' }])

      const cross = await adapter.execute(
        buildQuery(bridgeAst, ctx('acme'), {
          operation: 'findFirst',
          entity: 'Task',
          where: { id: 'br-b1' },
        }),
      )
      expect(cross).toBeNull()
    })
  })

  describe('silo (single-tenant / database-per-tenant)', () => {
    beforeAll(async () => {
      // Silo uses dedicated `silo_*` databases (created on first write); clear for exact canary asserts.
      await withAdmin(connectionString, async (client) => {
        await client.db('silo_acme').collection('Task').deleteMany({})
        await client.db('silo_beta').collection('Task').deleteMany({})
      })
    })

    it('routes to isolation.databaseName and keeps tenants apart', async () => {
      const ir = buildQuery(siloAst, ctx('acme'), {
        operation: 'create',
        entity: 'Task',
        data: { id: 'si-a1', title: 'Silo acme' },
      })
      expect(ir.isolation).toMatchObject({
        kind: 'database-per-tenant',
        databaseName: 'silo_acme',
        mongo: { databasePerTenant: true },
      })

      await adapter.execute(ir)
      await adapter.execute(
        buildQuery(siloAst, ctx('beta'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 'si-b1', title: 'Silo beta' },
        }),
      )

      const acme = await adapter.execute(
        buildQuery(siloAst, ctx('acme'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(acme).toEqual([{ id: 'si-a1', title: 'Silo acme' }])

      const beta = await adapter.execute(
        buildQuery(siloAst, ctx('beta'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(beta).toEqual([{ id: 'si-b1', title: 'Silo beta' }])
    })
  })

  describe('@@global (isolation none)', () => {
    it('reads and writes without tenant injection', async () => {
      const ir = buildQuery(globalAst, ctx('acme'), {
        operation: 'create',
        entity: 'Country',
        data: { id: 'br', code: 'BR' },
      })
      expect(ir.isolation).toEqual({ kind: 'none' })
      expect(ir.tenancyModel).toBe('global')

      await adapter.execute(ir)

      const fromOtherTenant = await adapter.execute(
        buildQuery(globalAst, ctx('beta'), {
          operation: 'findMany',
          entity: 'Country',
        }),
      )
      expect(fromOtherTenant).toEqual([{ id: 'br', code: 'BR' }])
    })
  })
})
