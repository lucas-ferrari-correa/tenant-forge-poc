import { MongoClient } from 'mongodb'
import mysql from 'mysql2/promise'
import pg from 'pg'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildQuery,
  CONTAINER_IMAGES,
  createMongodbAdapter,
  createMysqlAdapter,
  createPostgresAdapter,
  createTenantContext,
  defineSchema,
  type EntityDefinition,
  pushSchema,
  type SchemaAst,
} from '../index.js'

const { Client } = pg

const TENANTS = ['acme', 'beta'] as const

function idField(): EntityDefinition['fields'][number] {
  return { name: 'id', type: 'String', primaryKey: true }
}

function tenantIdField(): EntityDefinition['fields'][number] {
  return { name: 'tenant_id', type: 'String', isTenantId: true }
}

function ctx(tenantId: string) {
  return createTenantContext({ tenantId, source: 'jwt-claim' })
}

/** Hybrid AST covering pool + bridge + silo + @@global in one push. */
function hybridAst(): SchemaAst {
  return defineSchema({
    name: 'hybrid_push',
    tenancy: {
      model: 'hybrid',
      bindings: [],
      defaultModel: 'shared-db-shared-schema',
    },
    entities: [
      {
        name: 'Task',
        tenancyModel: 'shared-db-shared-schema',
        fields: [idField(), { name: 'title', type: 'String' }, tenantIdField()],
      },
      {
        name: 'Note',
        tenancyModel: 'shared-db-isolated-schema',
        fields: [idField(), { name: 'body', type: 'String' }],
      },
      {
        name: 'Ledger',
        tenancyModel: 'single-tenant',
        fields: [idField(), { name: 'balance', type: 'Int' }],
      },
      {
        name: 'Country',
        global: true,
        fields: [idField(), { name: 'code', type: 'String' }],
      },
    ],
  })
}

describe('schema push — plan validation', () => {
  it('requires tenants when bridge or silo entities are present', async () => {
    const ast = defineSchema({
      name: 'bridge_only',
      tenancy: { model: 'shared-db-isolated-schema' },
      entities: [
        {
          name: 'Note',
          fields: [idField(), { name: 'body', type: 'String' }],
        },
      ],
    })

    await expect(
      pushSchema(ast, { dialect: 'postgres', connectionString: 'postgres://x' }, {}),
    ).rejects.toMatchObject({ code: 'TENANTS_REQUIRED' })
  })

  it('does not require tenants for pure pool schemas', async () => {
    const { buildPushPlan } = await import('./plan.js')
    const ast = defineSchema({
      name: 'pool_only',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          fields: [idField(), { name: 'title', type: 'String' }, tenantIdField()],
        },
      ],
    })
    const plan = buildPushPlan(ast, {})
    expect(plan.needsTenantNamespaces).toBe(false)
    expect(plan.tenants).toEqual([])
  })
})

describe('schema push — postgres (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  const PG_USER = 'tenant'
  const PG_PASSWORD = 'tenant'
  const PG_DB = 'tenant_forge'

  beforeAll(async () => {
    container = await new GenericContainer(CONTAINER_IMAGES.postgres)
      .withEnvironment({
        POSTGRES_USER: PG_USER,
        POSTGRES_PASSWORD: PG_PASSWORD,
        POSTGRES_DB: PG_DB,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(5432)
    connectionString = `postgres://${PG_USER}:${PG_PASSWORD}@${host}:${port}/${PG_DB}`
  }, 120_000)

  afterAll(async () => {
    await container.stop()
  })

  it('pushes hybrid layout (pool RLS + bridge schemas + silo DBs + global) and smoke-executes', async () => {
    const ast = hybridAst()
    const result = await pushSchema(
      ast,
      { dialect: 'postgres', connectionString },
      { tenants: [...TENANTS] },
    )

    expect(result.dialect).toBe('postgres')
    expect(result.created.some((o) => o.kind === 'table' && o.name === 'Task')).toBe(true)
    expect(result.created.some((o) => o.kind === 'rls' && o.name === 'Task')).toBe(true)
    expect(result.created.some((o) => o.kind === 'schema' && o.name === 'tenant_acme')).toBe(true)
    expect(result.created.some((o) => o.kind === 'database' && o.name === 'tenant_acme')).toBe(true)
    expect(result.created.some((o) => o.kind === 'table' && o.name === 'Country')).toBe(true)

    // Catalog: pool table + RLS
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      const tables = await admin.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
        [['Task', 'Country']],
      )
      expect(tables.rows.map((r: { tablename: string }) => r.tablename).sort()).toEqual([
        'Country',
        'Task',
      ])

      const rls = await admin.query(
        `SELECT c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'Task'`,
      )
      expect(rls.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })

      const bridge = await admin.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'tenant_acme' AND tablename = 'Note'`,
      )
      expect(bridge.rowCount).toBe(1)
    } finally {
      await admin.end()
    }

    // Silo catalog
    const siloUrl = new URL(connectionString)
    siloUrl.pathname = '/tenant_acme'
    const silo = new Client({ connectionString: siloUrl.toString() })
    await silo.connect()
    try {
      const ledger = await silo.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'Ledger'`,
      )
      expect(ledger.rowCount).toBe(1)
    } finally {
      await silo.end()
    }

    // Idempotent re-push
    await expect(
      pushSchema(ast, { dialect: 'postgres', connectionString }, { tenants: [...TENANTS] }),
    ).resolves.toBeDefined()

    // Smoke via adapter
    const adapter = createPostgresAdapter({ connectionString })
    try {
      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 't1', title: 'Acme' },
        }),
      )
      await adapter.execute(
        buildQuery(ast, ctx('beta'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 't2', title: 'Beta' },
        }),
      )
      const acmeTasks = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(acmeTasks).toEqual([
        expect.objectContaining({ id: 't1', title: 'Acme', tenant_id: 'acme' }),
      ])

      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Note',
          data: { id: 'n1', body: 'hello' },
        }),
      )
      const notes = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Note' }),
      )
      expect(notes).toEqual([expect.objectContaining({ id: 'n1', body: 'hello' })])

      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Ledger',
          data: { id: 'l1', balance: 10 },
        }),
      )
      const ledgers = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Ledger' }),
      )
      expect(ledgers).toEqual([expect.objectContaining({ id: 'l1', balance: 10 })])

      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Country',
          data: { id: 'br', code: 'BR' },
        }),
      )
      const countries = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Country' }),
      )
      expect(countries).toEqual([expect.objectContaining({ id: 'br', code: 'BR' })])
    } finally {
      await adapter.dispose()
    }
  }, 120_000)
})

describe('schema push — mysql (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  const MYSQL_ROOT_PASSWORD = 'tenant'
  const MYSQL_DB = 'tenant_forge'

  async function waitForMysql(uri: string): Promise<void> {
    const deadline = Date.now() + 90_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const connection = await mysql.createConnection(uri)
        await connection.query('SELECT 1')
        await connection.end()
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
    throw new Error(`MySQL did not become ready: ${String(lastError)}`)
  }

  beforeAll(async () => {
    container = await new GenericContainer(CONTAINER_IMAGES.mysql)
      .withEnvironment({
        MYSQL_ROOT_PASSWORD,
        MYSQL_DATABASE: MYSQL_DB,
      })
      .withExposedPorts(3306)
      .withStartupTimeout(180_000)
      .withWaitStrategy(Wait.forLogMessage(/ready for connections/, 2))
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(3306)
    connectionString = `mysql://root:${MYSQL_ROOT_PASSWORD}@${host}:${port}/${MYSQL_DB}`
    await waitForMysql(connectionString)
  }, 180_000)

  afterAll(async () => {
    await container.stop()
  })

  it('pushes hybrid layout (pool + bridge/silo DBs + global) and smoke-executes', async () => {
    const ast = hybridAst()
    const result = await pushSchema(
      ast,
      { dialect: 'mysql', connectionString },
      { tenants: [...TENANTS] },
    )

    expect(result.dialect).toBe('mysql')
    expect(result.created.some((o) => o.kind === 'table' && o.name === 'Task')).toBe(true)
    expect(result.created.some((o) => o.kind === 'database' && o.name === 'tenant_acme')).toBe(true)

    const connection = await mysql.createConnection(connectionString)
    try {
      const [poolTables] = await connection.query(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('Task', 'Country')`,
        [MYSQL_DB],
      )
      const names = (poolTables as Array<{ name: string }>).map((r) => r.name).sort()
      expect(names).toEqual(['Country', 'Task'])

      const [bridgeTables] = await connection.query(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = 'tenant_acme' AND TABLE_NAME IN ('Note', 'Ledger')`,
      )
      expect((bridgeTables as Array<{ name: string }>).map((r) => r.name).sort()).toEqual([
        'Ledger',
        'Note',
      ])
    } finally {
      await connection.end()
    }

    await expect(
      pushSchema(ast, { dialect: 'mysql', connectionString }, { tenants: [...TENANTS] }),
    ).resolves.toBeDefined()

    const adapter = createMysqlAdapter({ connectionString })
    try {
      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 't1', title: 'Acme' },
        }),
      )
      await adapter.execute(
        buildQuery(ast, ctx('beta'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 't2', title: 'Beta' },
        }),
      )
      const acmeTasks = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(acmeTasks).toEqual([
        expect.objectContaining({ id: 't1', title: 'Acme', tenant_id: 'acme' }),
      ])

      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Note',
          data: { id: 'n1', body: 'hello' },
        }),
      )
      const notes = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Note' }),
      )
      expect(notes).toEqual([expect.objectContaining({ id: 'n1', body: 'hello' })])

      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Ledger',
          data: { id: 'l1', balance: 10 },
        }),
      )
      const ledgers = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Ledger' }),
      )
      expect(ledgers).toEqual([expect.objectContaining({ id: 'l1', balance: 10 })])
    } finally {
      await adapter.dispose()
    }
  }, 180_000)
})

describe('schema push — mongodb (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  const MONGO_DB = 'tenant_forge'

  async function waitForMongodb(uri: string): Promise<void> {
    const deadline = Date.now() + 90_000
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        const client = new MongoClient(uri)
        await client.connect()
        await client.db('admin').command({ ping: 1 })
        await client.close()
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
    }
    throw new Error(`MongoDB did not become ready: ${String(lastError)}`)
  }

  beforeAll(async () => {
    container = await new GenericContainer(CONTAINER_IMAGES.mongodb)
      .withExposedPorts(27017)
      .withStartupTimeout(180_000)
      .withWaitStrategy(Wait.forLogMessage(/"msg":"Waiting for connections"/))
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(27017)
    connectionString = `mongodb://${host}:${port}/${MONGO_DB}`
    await waitForMongodb(connectionString)
  }, 180_000)

  afterAll(async () => {
    await container.stop()
  })

  it('pushes hybrid layout (collections + tenant DBs + tenant_id index) and smoke-executes', async () => {
    const ast = hybridAst()
    const result = await pushSchema(
      ast,
      { dialect: 'mongodb', connectionString },
      { tenants: [...TENANTS] },
    )

    expect(result.dialect).toBe('mongodb')
    expect(result.warnings.some((w) => /no foreign-key/i.test(w))).toBe(true)
    expect(result.created.some((o) => o.kind === 'collection' && o.name === 'Task')).toBe(true)
    expect(result.created.some((o) => o.kind === 'index' && o.name === 'Task_tenant_id_idx')).toBe(
      true,
    )
    expect(result.created.some((o) => o.kind === 'collection' && o.name === 'Note')).toBe(true)

    const client = new MongoClient(connectionString)
    await client.connect()
    try {
      const defaultCols = await client.db(MONGO_DB).listCollections().toArray()
      const defaultNames = defaultCols.map((c) => c.name).sort()
      expect(defaultNames).toEqual(expect.arrayContaining(['Country', 'Task']))

      const tenantCols = await client.db('tenant_acme').listCollections().toArray()
      const tenantNames = tenantCols.map((c) => c.name).sort()
      expect(tenantNames).toEqual(expect.arrayContaining(['Ledger', 'Note']))

      const indexes = await client.db(MONGO_DB).collection('Task').indexes()
      expect(indexes.some((idx) => idx.name === 'Task_tenant_id_idx')).toBe(true)
    } finally {
      await client.close()
    }

    await expect(
      pushSchema(ast, { dialect: 'mongodb', connectionString }, { tenants: [...TENANTS] }),
    ).resolves.toBeDefined()

    const adapter = createMongodbAdapter({ connectionString })
    try {
      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 't1', title: 'Acme' },
        }),
      )
      await adapter.execute(
        buildQuery(ast, ctx('beta'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 't2', title: 'Beta' },
        }),
      )
      const acmeTasks = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(acmeTasks).toEqual([
        expect.objectContaining({ id: 't1', title: 'Acme', tenant_id: 'acme' }),
      ])

      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Note',
          data: { id: 'n1', body: 'hello' },
        }),
      )
      const notes = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Note' }),
      )
      expect(notes).toEqual([expect.objectContaining({ id: 'n1', body: 'hello' })])

      await adapter.execute(
        buildQuery(ast, ctx('acme'), {
          operation: 'create',
          entity: 'Ledger',
          data: { id: 'l1', balance: 10 },
        }),
      )
      const ledgers = await adapter.execute(
        buildQuery(ast, ctx('acme'), { operation: 'findMany', entity: 'Ledger' }),
      )
      expect(ledgers).toEqual([expect.objectContaining({ id: 'l1', balance: 10 })])
    } finally {
      await adapter.dispose()
    }
  }, 180_000)
})
