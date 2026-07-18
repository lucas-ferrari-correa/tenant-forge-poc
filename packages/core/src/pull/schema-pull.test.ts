import { MongoClient } from 'mongodb'
import mysql from 'mysql2/promise'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CONTAINER_IMAGES,
  defineSchema,
  type EntityDefinition,
  pullSchema,
  pushSchema,
  resolveEntityTenancy,
  type SchemaAst,
} from '../index.js'
import type { CatalogObject } from './catalog.js'
import { buildEntitySignalsFromObjects, classifyEntityTenancy } from './infer.js'

const TENANTS = ['acme', 'beta'] as const

function idField(): EntityDefinition['fields'][number] {
  return { name: 'id', type: 'String', primaryKey: true }
}

function tenantIdField(): EntityDefinition['fields'][number] {
  return { name: 'tenant_id', type: 'String', isTenantId: true }
}

function col(
  name: string,
  opts?: { tenantId?: boolean; pk?: boolean },
): CatalogObject['columns'][number] {
  return {
    name,
    nativeType: 'text',
    nullable: false,
    isPrimaryKey: opts?.pk === true,
  }
}

function catalogObject(
  name: string,
  namespaceKind: CatalogObject['namespaceKind'],
  namespace: string,
  columns: CatalogObject['columns'],
  extra?: Partial<CatalogObject>,
): CatalogObject {
  return {
    name,
    namespace,
    namespaceKind,
    columns,
    foreignKeys: [],
    kind: 'table',
    ...extra,
  }
}

/** Hybrid AST: pool + bridge + silo + @@global (same as push tests). */
function hybridAst(): SchemaAst {
  return defineSchema({
    name: 'hybrid_pull',
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

function expectTenancyEquivalent(source: SchemaAst, pulled: SchemaAst): void {
  for (const entity of source.entities) {
    const pulledEntity = pulled.entities.find((candidate) => candidate.name === entity.name)
    expect(pulledEntity, `missing entity ${entity.name}`).toBeDefined()
    if (entity.global === true) {
      expect(pulledEntity?.global, entity.name).toBe(true)
      continue
    }
    const expected = resolveEntityTenancy(source, entity.name)
    const actual = resolveEntityTenancy(pulled, entity.name)
    expect(actual, entity.name).toBe(expected)
  }
}

describe('schema pull — tenancy heuristic (unit)', () => {
  it('classifies pool from default namespace + tenant_id (+ RLS strong signal)', () => {
    const [signals] = buildEntitySignalsFromObjects([
      catalogObject('Task', 'default', 'public', [col('id', { pk: true }), col('tenant_id')], {
        rlsEnabled: true,
        rlsTenantPolicy: true,
      }),
    ])
    const result = classifyEntityTenancy(signals, 'postgres')
    expect(result.model).toBe('shared-db-shared-schema')
    expect(result.signals.some((s) => /tenant_id/.test(s))).toBe(true)
    expect(result.signals.some((s) => /RLS/.test(s))).toBe(true)
  })

  it('classifies bridge from tenant_* schemas without tenant_id (Postgres)', () => {
    const [signals] = buildEntitySignalsFromObjects([
      catalogObject('Note', 'tenant-schema', 'tenant_acme', [col('id', { pk: true }), col('body')]),
      catalogObject('Note', 'tenant-schema', 'tenant_beta', [col('id', { pk: true }), col('body')]),
    ])
    expect(classifyEntityTenancy(signals, 'postgres').model).toBe('shared-db-isolated-schema')
  })

  it('classifies silo from silo_* databases without tenant_id (all dialects)', () => {
    for (const dialect of ['postgres', 'mysql', 'mongodb'] as const) {
      const [signals] = buildEntitySignalsFromObjects([
        catalogObject('Ledger', 'silo-database', 'silo_acme', [
          col('id', { pk: true }),
          col('balance'),
        ]),
      ])
      expect(classifyEntityTenancy(signals, dialect).model).toBe('single-tenant')
    }
  })

  it('classifies @@global from default-only without tenant_id or clones', () => {
    const [signals] = buildEntitySignalsFromObjects([
      catalogObject('Country', 'default', 'public', [col('id', { pk: true }), col('code')]),
    ])
    expect(classifyEntityTenancy(signals, 'postgres').model).toBe('global')
  })

  it('classifies bridge from tenant_* databases without tenant_id (MySQL/Mongo)', () => {
    const [signals] = buildEntitySignalsFromObjects([
      catalogObject('Note', 'tenant-database', 'tenant_acme', [
        col('id', { pk: true }),
        col('body'),
      ]),
    ])
    expect(classifyEntityTenancy(signals, 'mysql').model).toBe('shared-db-isolated-schema')
    expect(classifyEntityTenancy(signals, 'mongodb').model).toBe('shared-db-isolated-schema')
  })

  it('fails closed when an entity spans both silo_* and tenant_* namespaces', () => {
    const [signals] = buildEntitySignalsFromObjects([
      catalogObject('Mix', 'tenant-database', 'tenant_acme', [col('id', { pk: true })]),
      catalogObject('Mix', 'silo-database', 'silo_acme', [col('id', { pk: true })]),
    ])
    expect(() => classifyEntityTenancy(signals, 'mysql')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_TENANCY' }),
    )
    expect(classifyEntityTenancy(signals, 'mysql', { assumeTenancy: 'single-tenant' }).model).toBe(
      'single-tenant',
    )
  })

  it('fails closed on tenant_id inside tenant_* without hint', () => {
    const [signals] = buildEntitySignalsFromObjects([
      catalogObject('Task', 'tenant-schema', 'tenant_acme', [
        col('id', { pk: true }),
        col('tenant_id'),
      ]),
    ])
    expect(() => classifyEntityTenancy(signals, 'postgres')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_TENANCY' }),
    )
  })

  it('fails closed when tenant_id in default conflicts with tenant_* clones', () => {
    const [signals] = buildEntitySignalsFromObjects([
      catalogObject('Task', 'default', 'public', [col('id', { pk: true }), col('tenant_id')]),
      catalogObject('Task', 'tenant-schema', 'tenant_acme', [
        col('id', { pk: true }),
        col('title'),
      ]),
    ])
    expect(() => classifyEntityTenancy(signals, 'postgres')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_TENANCY' }),
    )
  })

  it('honors entityTenancy override over auto classification', () => {
    const [signals] = buildEntitySignalsFromObjects([
      catalogObject('Note', 'tenant-database', 'tenant_acme', [col('id', { pk: true })]),
    ])
    const result = classifyEntityTenancy(signals, 'mysql', {
      entityTenancy: { Note: 'single-tenant' },
      assumeTenancy: 'shared-db-isolated-schema',
    })
    expect(result.model).toBe('single-tenant')
    expect(result.fromHint).toBe(true)
  })
})

describe('schema pull — postgres push→pull (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  const PG_USER = 'tenant'
  const PG_PASSWORD = 'tenant'
  const PG_DB = 'tenant_forge_pull'

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

  it('pulls hybrid layout with equivalent tenancy (auto, no hints)', async () => {
    const source = hybridAst()
    await pushSchema(source, { dialect: 'postgres', connectionString }, { tenants: [...TENANTS] })

    const result = await pullSchema(
      { dialect: 'postgres', connectionString },
      { schemaName: 'hybrid_pull' },
    )

    expect(result.dialect).toBe('postgres')
    expect(result.ast.tenancy.model).toBe('hybrid')
    expectTenancyEquivalent(source, result.ast)

    const task = result.ast.entities.find((e) => e.name === 'Task')
    expect(task?.fields.some((f) => f.name === 'tenant_id' && f.isTenantId === true)).toBe(true)
    expect(task?.fields.some((f) => f.name === 'title')).toBe(true)

    const note = result.ast.entities.find((e) => e.name === 'Note')
    expect(note?.fields.some((f) => f.name === 'body')).toBe(true)
    expect(note?.fields.some((f) => f.name === 'tenant_id')).toBe(false)

    const inferredTask = result.inferred.find((i) => i.entity === 'Task')
    expect(inferredTask?.signals.some((s) => /RLS|tenant_id/.test(s))).toBe(true)
  }, 120_000)
})

describe('schema pull — mysql push→pull (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  const MYSQL_ROOT_PASSWORD = 'tenant'
  const MYSQL_DB = 'tenant_forge_pull'

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

  it('pulls hybrid layout with equivalent tenancy (auto — silo_ prefix disambiguates)', async () => {
    const source = hybridAst()
    await pushSchema(source, { dialect: 'mysql', connectionString }, { tenants: [...TENANTS] })

    const result = await pullSchema(
      { dialect: 'mysql', connectionString },
      { schemaName: 'hybrid_pull' },
    )

    expect(result.dialect).toBe('mysql')
    expect(result.ast.tenancy.model).toBe('hybrid')
    expectTenancyEquivalent(source, result.ast)

    const note = result.inferred.find((i) => i.entity === 'Note')
    expect(note?.model).toBe('shared-db-isolated-schema')
    const ledger = result.inferred.find((i) => i.entity === 'Ledger')
    expect(ledger?.model).toBe('single-tenant')

    const task = result.ast.entities.find((e) => e.name === 'Task')
    expect(task?.fields.some((f) => f.name === 'title')).toBe(true)
  }, 180_000)
})

describe('schema pull — mongodb push→pull (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  const MONGO_DB = 'tenant_forge_pull'

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

  it('pulls hybrid auto (silo_ prefix); samples docs for fields; warns on missing FKs', async () => {
    const source = hybridAst()
    await pushSchema(source, { dialect: 'mongodb', connectionString }, { tenants: [...TENANTS] })

    // Seed documents so field introspection has shapes (empty collections only yield indexes).
    const client = new MongoClient(connectionString)
    await client.connect()
    try {
      await client.db(MONGO_DB).collection('Task').insertOne({
        id: 't1',
        title: 'Acme',
        tenant_id: 'acme',
      })
      await client.db(MONGO_DB).collection('Country').insertOne({ id: 'br', code: 'BR' })
      await client.db('tenant_acme').collection('Note').insertOne({ id: 'n1', body: 'hello' })
      await client.db('silo_acme').collection('Ledger').insertOne({ id: 'l1', balance: 10 })
    } finally {
      await client.close()
    }

    const result = await pullSchema(
      { dialect: 'mongodb', connectionString },
      { schemaName: 'hybrid_pull' },
    )

    expect(result.dialect).toBe('mongodb')
    expect(result.warnings.some((w) => /no foreign-key/i.test(w))).toBe(true)
    expect(result.ast.tenancy.model).toBe('hybrid')
    expect(result.inferred.find((i) => i.entity === 'Note')?.model).toBe(
      'shared-db-isolated-schema',
    )
    expect(result.inferred.find((i) => i.entity === 'Ledger')?.model).toBe('single-tenant')
    expectTenancyEquivalent(source, result.ast)

    const task = result.ast.entities.find((e) => e.name === 'Task')
    expect(task?.fields.some((f) => f.name === 'tenant_id' && f.isTenantId === true)).toBe(true)
    expect(task?.fields.some((f) => f.name === 'title')).toBe(true)
  }, 180_000)
})
