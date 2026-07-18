import { MongoClient } from 'mongodb'
import mysql from 'mysql2/promise'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CONTAINER_IMAGES,
  createSchemaDiffer,
  defineSchema,
  diffSchemaAgainstDb,
  diffSchemas,
  type EntityDefinition,
  pushSchema,
  type SchemaAst,
  SchemaDiffError,
} from '../index.js'

const TENANTS = ['acme', 'beta'] as const

function idField(): EntityDefinition['fields'][number] {
  return { name: 'id', type: 'String', primaryKey: true }
}

function tenantIdField(): EntityDefinition['fields'][number] {
  return { name: 'tenant_id', type: 'String', isTenantId: true }
}

function poolAst(name = 'pool_diff'): SchemaAst {
  return defineSchema({
    name,
    tenancy: { model: 'shared-db-shared-schema' },
    entities: [
      {
        name: 'Task',
        fields: [idField(), { name: 'title', type: 'String' }, tenantIdField()],
      },
    ],
  })
}

function hybridAst(name = 'hybrid_diff'): SchemaAst {
  return defineSchema({
    name,
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

function relatedAst(): SchemaAst {
  return defineSchema({
    name: 'related',
    tenancy: { model: 'shared-db-shared-schema' },
    entities: [
      {
        name: 'Author',
        fields: [idField(), { name: 'name', type: 'String' }, tenantIdField()],
      },
      {
        name: 'Post',
        fields: [
          idField(),
          { name: 'title', type: 'String' },
          { name: 'authorId', type: 'String' },
          tenantIdField(),
        ],
        relations: [
          {
            name: 'author',
            kind: 'many-to-one',
            target: 'Author',
            fields: ['authorId'],
            references: ['id'],
          },
        ],
      },
    ],
  })
}

describe('schema diff — unit (AST↔AST)', () => {
  it('reports equal for identical schemas (ignoreSchemaName default)', () => {
    const local = poolAst('local')
    const remote = poolAst('remote')
    const result = diffSchemas(local, remote)
    expect(result.equal).toBe(true)
    expect(result.changes).toEqual([])
  })

  it('reports schema.name mismatch when ignoreSchemaName is false', () => {
    const result = diffSchemas(poolAst('a'), poolAst('b'), { ignoreSchemaName: false })
    expect(result.equal).toBe(false)
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        kind: 'mismatch',
        path: 'schema.name',
        local: 'a',
        remote: 'b',
      }),
    )
  })

  it('reports entity localOnly and remoteOnly', () => {
    const local = defineSchema({
      name: 's',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          fields: [idField(), { name: 'title', type: 'String' }, tenantIdField()],
        },
        {
          name: 'OnlyLocal',
          fields: [idField(), tenantIdField()],
        },
      ],
    })
    const remote = defineSchema({
      name: 's',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          fields: [idField(), { name: 'title', type: 'String' }, tenantIdField()],
        },
        {
          name: 'OnlyRemote',
          fields: [idField(), tenantIdField()],
        },
      ],
    })

    const result = diffSchemas(local, remote)
    expect(result.equal).toBe(false)
    expect(result.changes).toContainEqual(
      expect.objectContaining({ kind: 'localOnly', path: 'entities.OnlyLocal' }),
    )
    expect(result.changes).toContainEqual(
      expect.objectContaining({ kind: 'remoteOnly', path: 'entities.OnlyRemote' }),
    )
  })

  it('reports field localOnly, remoteOnly, and type mismatch', () => {
    const local = defineSchema({
      name: 's',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          fields: [
            idField(),
            { name: 'title', type: 'String' },
            { name: 'localOnly', type: 'Int' },
            tenantIdField(),
          ],
        },
      ],
    })
    const remote = defineSchema({
      name: 's',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          fields: [
            idField(),
            { name: 'title', type: 'Int' },
            { name: 'remoteOnly', type: 'String' },
            tenantIdField(),
          ],
        },
      ],
    })

    const result = diffSchemas(local, remote)
    expect(result.changes).toContainEqual(
      expect.objectContaining({ kind: 'localOnly', path: 'entities.Task.fields.localOnly' }),
    )
    expect(result.changes).toContainEqual(
      expect.objectContaining({ kind: 'remoteOnly', path: 'entities.Task.fields.remoteOnly' }),
    )
    expect(result.changes).toContainEqual(
      expect.objectContaining({ kind: 'mismatch', path: 'entities.Task.fields.title' }),
    )
  })

  it('reports relation localOnly and kind mismatch', () => {
    const local = relatedAst()
    const remote = defineSchema({
      name: 'related',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Author',
          fields: [idField(), { name: 'name', type: 'String' }, tenantIdField()],
        },
        {
          name: 'Post',
          fields: [
            idField(),
            { name: 'title', type: 'String' },
            { name: 'authorId', type: 'String' },
            tenantIdField(),
          ],
          relations: [
            {
              name: 'author',
              kind: 'one-to-one',
              target: 'Author',
              fields: ['authorId'],
              references: ['id'],
            },
          ],
        },
      ],
    })

    const result = diffSchemas(local, remote)
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        kind: 'mismatch',
        path: 'entities.Post.relations.author',
      }),
    )

    const withoutRemoteRel = defineSchema({
      name: 'related',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Author',
          fields: [idField(), { name: 'name', type: 'String' }, tenantIdField()],
        },
        {
          name: 'Post',
          fields: [
            idField(),
            { name: 'title', type: 'String' },
            { name: 'authorId', type: 'String' },
            tenantIdField(),
          ],
        },
      ],
    })
    const missing = diffSchemas(local, withoutRemoteRel)
    expect(missing.changes).toContainEqual(
      expect.objectContaining({
        kind: 'localOnly',
        path: 'entities.Post.relations.author',
      }),
    )
  })

  it('reports schema and entity tenancy mismatches', () => {
    const local = poolAst()
    const remote = defineSchema({
      name: 'pool_diff',
      tenancy: { model: 'single-tenant' },
      entities: [
        {
          name: 'Task',
          fields: [idField(), { name: 'title', type: 'String' }],
        },
      ],
    })
    const result = diffSchemas(local, remote)
    expect(result.changes).toContainEqual(
      expect.objectContaining({ kind: 'mismatch', path: 'schema.tenancy' }),
    )

    const hybridLocal = hybridAst()
    const hybridRemote = defineSchema({
      name: 'hybrid_diff',
      tenancy: {
        model: 'hybrid',
        bindings: [],
        defaultModel: 'shared-db-shared-schema',
      },
      entities: [
        {
          name: 'Task',
          tenancyModel: 'single-tenant',
          fields: [idField(), { name: 'title', type: 'String' }],
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
    const entityTenancy = diffSchemas(hybridLocal, hybridRemote)
    expect(entityTenancy.changes).toContainEqual(
      expect.objectContaining({ kind: 'mismatch', path: 'entities.Task.tenancy' }),
    )
  })

  it('compares services when present; skips with ignoreServices warning', () => {
    const withService = defineSchema({
      name: 'svc',
      tenancy: {
        model: 'hybrid',
        bindings: [],
        defaultModel: 'shared-db-shared-schema',
      },
      entities: [
        {
          name: 'Task',
          tenancyModel: 'shared-db-shared-schema',
          fields: [idField(), tenantIdField()],
        },
      ],
      services: [
        {
          name: 'Tasks',
          tenancyModel: 'shared-db-shared-schema',
          entities: ['Task'],
        },
      ],
    })
    const withoutService = defineSchema({
      name: 'svc',
      tenancy: {
        model: 'hybrid',
        bindings: [],
        defaultModel: 'shared-db-shared-schema',
      },
      entities: [
        {
          name: 'Task',
          tenancyModel: 'shared-db-shared-schema',
          fields: [idField(), tenantIdField()],
        },
      ],
    })

    const compared = diffSchemas(withService, withoutService)
    expect(compared.changes).toContainEqual(
      expect.objectContaining({ kind: 'localOnly', path: 'services.Tasks' }),
    )

    const skipped = diffSchemas(withService, withoutService, { ignoreServices: true })
    expect(skipped.equal).toBe(true)
    expect(skipped.warnings.some((w) => /services comparison skipped/i.test(w))).toBe(true)
  })

  it('treats field defaults as best-effort (skip when remote omits)', () => {
    const local = defineSchema({
      name: 's',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          fields: [
            idField(),
            { name: 'title', type: 'String', default: { kind: 'literal', value: 'x' } },
            tenantIdField(),
          ],
        },
      ],
    })
    const remote = defineSchema({
      name: 's',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          fields: [idField(), { name: 'title', type: 'String' }, tenantIdField()],
        },
      ],
    })
    expect(diffSchemas(local, remote).equal).toBe(true)

    const both = defineSchema({
      name: 's',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          fields: [
            idField(),
            { name: 'title', type: 'String', default: { kind: 'literal', value: 'y' } },
            tenantIdField(),
          ],
        },
      ],
    })
    expect(diffSchemas(local, both).equal).toBe(false)
  })

  it('throws SchemaDiffError on invalid input AST', () => {
    const invalid = {
      name: '',
      tenancy: { model: 'shared-db-shared-schema' as const },
      entities: [],
    }
    expect(() => diffSchemas(invalid, poolAst())).toThrow(SchemaDiffError)
  })
})

describe('schema diff — postgres push→pull (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string
  let pushed: SchemaAst

  const PG_USER = 'tenant'
  const PG_PASSWORD = 'tenant'
  const PG_DB = 'tenant_forge_diff'

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

    pushed = hybridAst('pg_hybrid')
    await pushSchema(pushed, { dialect: 'postgres', connectionString }, { tenants: [...TENANTS] })
  }, 120_000)

  afterAll(async () => {
    await container.stop()
  })

  it('push→pull→diff is empty for hybrid layout', async () => {
    const result = await diffSchemaAgainstDb(
      pushed,
      { dialect: 'postgres', connectionString },
      { pull: { schemaName: 'pg_hybrid' } },
    )

    expect(result.dialect).toBe('postgres')
    expect(result.pull).toBeDefined()
    expect(result.equal).toBe(true)
    expect(result.changes).toEqual([])
  }, 120_000)

  it('reports changes when local diverges after push', async () => {
    const diverged: SchemaAst = defineSchema({
      name: 'pg_hybrid',
      tenancy: {
        model: 'hybrid',
        bindings: [],
        defaultModel: 'shared-db-shared-schema',
      },
      entities: [
        {
          name: 'Task',
          tenancyModel: 'shared-db-shared-schema',
          fields: [
            idField(),
            { name: 'title', type: 'String' },
            { name: 'priority', type: 'Int' },
            tenantIdField(),
          ],
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

    const result = await createSchemaDiffer({
      dialect: 'postgres',
      connectionString,
    }).diff(diverged, { pull: { schemaName: 'pg_hybrid' } })

    expect(result.equal).toBe(false)
    expect(result.changes).toContainEqual(
      expect.objectContaining({
        kind: 'localOnly',
        path: 'entities.Task.fields.priority',
      }),
    )
  }, 120_000)
})

describe('schema diff — mysql push→pull (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  const MYSQL_ROOT_PASSWORD = 'tenant'
  const MYSQL_DB = 'tenant_forge_diff'

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

  it('push→pull→diff is empty for pool layout', async () => {
    const local = poolAst('mysql_pool')
    await pushSchema(local, { dialect: 'mysql', connectionString }, {})

    const result = await diffSchemaAgainstDb(
      local,
      { dialect: 'mysql', connectionString },
      { pull: { schemaName: 'mysql_pool' } },
    )

    expect(result.dialect).toBe('mysql')
    expect(result.equal).toBe(true)
    expect(result.changes).toEqual([])
  }, 180_000)
})

describe('schema diff — mongodb push→pull (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  const MONGO_DB = 'tenant_forge_diff'

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

  it('push→pull→diff is empty for pool after seeding docs', async () => {
    const local = poolAst('mongo_pool')
    await pushSchema(local, { dialect: 'mongodb', connectionString }, {})

    const client = new MongoClient(connectionString)
    await client.connect()
    try {
      await client.db(MONGO_DB).collection('Task').insertOne({
        id: 't1',
        title: 'hello',
        tenant_id: 'acme',
      })
    } finally {
      await client.close()
    }

    const result = await diffSchemaAgainstDb(
      local,
      { dialect: 'mongodb', connectionString },
      { pull: { schemaName: 'mongo_pool' } },
    )

    expect(result.dialect).toBe('mongodb')
    expect(result.equal).toBe(true)
    expect(result.changes).toEqual([])
  }, 180_000)
})
