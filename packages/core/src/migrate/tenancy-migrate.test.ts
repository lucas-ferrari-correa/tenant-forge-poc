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
  migrateTenancy,
  pushSchema,
  type SchemaAst,
  TenancyMigrateError,
} from '../index.js'
import { buildMigratePlan, isSupportedTransition } from './plan.js'

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

function poolAst(name = 'pool_task', entity = 'Task'): SchemaAst {
  return defineSchema({
    name,
    tenancy: { model: 'shared-db-shared-schema' },
    entities: [
      {
        name: entity,
        fields: [idField(), { name: 'title', type: 'String' }, tenantIdField()],
      },
    ],
  })
}

function bridgeAst(name = 'bridge_task', entity = 'Task'): SchemaAst {
  return defineSchema({
    name,
    tenancy: { model: 'shared-db-isolated-schema' },
    entities: [
      {
        name: entity,
        fields: [idField(), { name: 'title', type: 'String' }],
      },
    ],
  })
}

function siloAst(name = 'silo_task', entity = 'Task'): SchemaAst {
  return defineSchema({
    name,
    tenancy: { model: 'single-tenant' },
    entities: [
      {
        name: entity,
        fields: [idField(), { name: 'title', type: 'String' }],
      },
    ],
  })
}

describe('tenancy migrate — plan (unit)', () => {
  it('requires tenants', () => {
    expect(() => buildMigratePlan(poolAst(), bridgeAst(), { tenants: [] })).toThrowError(
      TenancyMigrateError,
    )
    try {
      buildMigratePlan(poolAst(), bridgeAst(), { tenants: [] })
    } catch (error) {
      expect(error).toMatchObject({ code: 'TENANTS_REQUIRED' })
    }
  })

  it('plans pool→bridge migrate and from≡to noop', () => {
    const migrate = buildMigratePlan(poolAst(), bridgeAst(), { tenants: [...TENANTS] })
    expect(migrate.steps).toEqual([
      {
        entity: 'Task',
        from: 'shared-db-shared-schema',
        to: 'shared-db-isolated-schema',
        action: 'migrate',
      },
    ])

    const noop = buildMigratePlan(poolAst(), poolAst('same'), { tenants: [...TENANTS] })
    expect(noop.steps[0]?.action).toBe('noop')
  })

  it('plans all six concrete directed edges as supported', () => {
    const models = [
      'shared-db-shared-schema',
      'shared-db-isolated-schema',
      'single-tenant',
    ] as const
    for (const from of models) {
      for (const to of models) {
        expect(isSupportedTransition(from, to)).toBe(true)
      }
    }
    expect(isSupportedTransition('global', 'shared-db-shared-schema')).toBe(false)
    expect(isSupportedTransition('shared-db-shared-schema', 'global')).toBe(false)
  })

  it('rejects global↔concrete as UNSUPPORTED_TRANSITION', () => {
    const globalAst = defineSchema({
      name: 'g',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        { name: 'Country', global: true, fields: [idField(), { name: 'code', type: 'String' }] },
      ],
    })
    const concrete = defineSchema({
      name: 'c',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Country',
          fields: [idField(), { name: 'code', type: 'String' }, tenantIdField()],
        },
      ],
    })
    expect(() => buildMigratePlan(globalAst, concrete, { tenants: [...TENANTS] })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_TRANSITION' }),
    )
  })

  it('hybrid migrates only entities whose concrete model changes', () => {
    const source = defineSchema({
      name: 'hy_src',
      tenancy: { model: 'hybrid', bindings: [], defaultModel: 'shared-db-shared-schema' },
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
      ],
    })
    const target = defineSchema({
      name: 'hy_dst',
      tenancy: { model: 'hybrid', bindings: [], defaultModel: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          tenancyModel: 'shared-db-isolated-schema',
          fields: [idField(), { name: 'title', type: 'String' }],
        },
        {
          name: 'Note',
          tenancyModel: 'shared-db-isolated-schema',
          fields: [idField(), { name: 'body', type: 'String' }],
        },
      ],
    })
    const plan = buildMigratePlan(source, target, { tenants: [...TENANTS] })
    expect(plan.steps.find((s) => s.entity === 'Task')?.action).toBe('migrate')
    expect(plan.steps.find((s) => s.entity === 'Note')?.action).toBe('noop')
  })
})

describe('tenancy migrate — postgres (testcontainers)', () => {
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

  it('migrates pool→bridge with data move and canary A≠B', async () => {
    const entity = 'PgTask1'
    const source = poolAst('pg_pool_bridge', entity)
    const target = bridgeAst('pg_bridge', entity)
    await pushSchema(source, { dialect: 'postgres', connectionString }, { tenants: [...TENANTS] })

    const adapter = createPostgresAdapter({ connectionString })
    try {
      await adapter.execute(
        buildQuery(source, ctx('acme'), {
          operation: 'create',
          entity,
          data: { id: 't-acme', title: 'Acme task' },
        }),
      )
      await adapter.execute(
        buildQuery(source, ctx('beta'), {
          operation: 'create',
          entity,
          data: { id: 't-beta', title: 'Beta task' },
        }),
      )
    } finally {
      await adapter.dispose()
    }

    const result = await migrateTenancy(
      target,
      { dialect: 'postgres', connectionString },
      { tenants: [...TENANTS], from: source },
    )

    expect(result.dialect).toBe('postgres')
    expect(result.steps[0]?.action).toBe('migrate')
    expect(result.migrated.some((m) => m.tenant === 'acme' && m.rows >= 1)).toBe(true)

    const bridgeAdapter = createPostgresAdapter({ connectionString })
    try {
      const acme = await bridgeAdapter.execute(
        buildQuery(target, ctx('acme'), { operation: 'findMany', entity }),
      )
      const beta = await bridgeAdapter.execute(
        buildQuery(target, ctx('beta'), { operation: 'findMany', entity }),
      )
      expect(acme).toEqual([expect.objectContaining({ id: 't-acme', title: 'Acme task' })])
      expect(beta).toEqual([expect.objectContaining({ id: 't-beta', title: 'Beta task' })])
      expect(Array.isArray(acme) && acme[0] && !('tenant_id' in acme[0])).toBe(true)
    } finally {
      await bridgeAdapter.dispose()
    }
  }, 60_000)

  it('migrates bridge→pool and pool→silo (silo edge)', async () => {
    const entity = 'PgTask2'
    const bridge = bridgeAst('pg_b2p', entity)
    const pool = poolAst('pg_b2p_pool', entity)
    await pushSchema(bridge, { dialect: 'postgres', connectionString }, { tenants: [...TENANTS] })

    const seed = createPostgresAdapter({ connectionString })
    try {
      await seed.execute(
        buildQuery(bridge, ctx('acme'), {
          operation: 'create',
          entity,
          data: { id: 'b2p-a', title: 'from bridge a' },
        }),
      )
      await seed.execute(
        buildQuery(bridge, ctx('beta'), {
          operation: 'create',
          entity,
          data: { id: 'b2p-b', title: 'from bridge b' },
        }),
      )
    } finally {
      await seed.dispose()
    }

    const toPool = await migrateTenancy(
      pool,
      { dialect: 'postgres', connectionString },
      { tenants: [...TENANTS], from: bridge },
    )
    expect(toPool.steps[0]?.from).toBe('shared-db-isolated-schema')
    expect(toPool.steps[0]?.to).toBe('shared-db-shared-schema')

    const poolAdapter = createPostgresAdapter({ connectionString })
    try {
      const acme = await poolAdapter.execute(
        buildQuery(pool, ctx('acme'), { operation: 'findMany', entity }),
      )
      expect(acme).toEqual([
        expect.objectContaining({ id: 'b2p-a', title: 'from bridge a', tenant_id: 'acme' }),
      ])
    } finally {
      await poolAdapter.dispose()
    }

    // Second transition on same data: pool → silo
    const silo = siloAst('pg_pool_silo', entity)
    const toSilo = await migrateTenancy(
      silo,
      { dialect: 'postgres', connectionString },
      { tenants: [...TENANTS], from: pool },
    )
    expect(toSilo.steps[0]?.to).toBe('single-tenant')

    const siloAdapter = createPostgresAdapter({ connectionString })
    try {
      const acme = await siloAdapter.execute(
        buildQuery(silo, ctx('acme'), { operation: 'findMany', entity }),
      )
      const beta = await siloAdapter.execute(
        buildQuery(silo, ctx('beta'), { operation: 'findMany', entity }),
      )
      expect(acme).toEqual([expect.objectContaining({ id: 'b2p-a' })])
      expect(beta).toEqual([expect.objectContaining({ id: 'b2p-b' })])
    } finally {
      await siloAdapter.dispose()
    }
  }, 90_000)
})

describe('tenancy migrate — mysql (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  const MYSQL_ROOT = 'root'
  const MYSQL_PASSWORD = 'tenant'
  const MYSQL_DB = 'tenant_forge'

  beforeAll(async () => {
    container = await new GenericContainer(CONTAINER_IMAGES.mysql)
      .withEnvironment({
        MYSQL_ROOT_PASSWORD: MYSQL_PASSWORD,
        MYSQL_DATABASE: MYSQL_DB,
      })
      .withExposedPorts(3306)
      .withWaitStrategy(Wait.forLogMessage(/ready for connections/, 2))
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(3306)
    connectionString = `mysql://${MYSQL_ROOT}:${MYSQL_PASSWORD}@${host}:${port}/${MYSQL_DB}`

    // Ping retry — MySQL log-ready can precede accept
    const mysql = await import('mysql2/promise')
    for (let i = 0; i < 30; i++) {
      try {
        const conn = await mysql.createConnection(connectionString)
        await conn.query('SELECT 1')
        await conn.end()
        break
      } catch {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }, 180_000)

  afterAll(async () => {
    await container.stop()
  })

  it('migrates pool↔bridge with data move and canary A≠B', async () => {
    const source = poolAst('my_pool')
    const target = bridgeAst('my_bridge')
    await pushSchema(source, { dialect: 'mysql', connectionString }, { tenants: [...TENANTS] })

    const adapter = createMysqlAdapter({ connectionString })
    try {
      await adapter.execute(
        buildQuery(source, ctx('acme'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 'my-a', title: 'Acme' },
        }),
      )
      await adapter.execute(
        buildQuery(source, ctx('beta'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 'my-b', title: 'Beta' },
        }),
      )
    } finally {
      await adapter.dispose()
    }

    const toBridge = await migrateTenancy(
      target,
      { dialect: 'mysql', connectionString },
      { tenants: [...TENANTS], from: source },
    )
    expect(toBridge.migrated.some((m) => m.rows >= 1)).toBe(true)

    const bridgeAdapter = createMysqlAdapter({ connectionString })
    try {
      const acme = await bridgeAdapter.execute(
        buildQuery(target, ctx('acme'), { operation: 'findMany', entity: 'Task' }),
      )
      const beta = await bridgeAdapter.execute(
        buildQuery(target, ctx('beta'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(acme).toEqual([expect.objectContaining({ id: 'my-a', title: 'Acme' })])
      expect(beta).toEqual([expect.objectContaining({ id: 'my-b', title: 'Beta' })])
    } finally {
      await bridgeAdapter.dispose()
    }

    // Reverse: bridge → pool
    const back = await migrateTenancy(
      source,
      { dialect: 'mysql', connectionString },
      { tenants: [...TENANTS], from: target },
    )
    expect(back.steps[0]?.to).toBe('shared-db-shared-schema')

    const poolAdapter = createMysqlAdapter({ connectionString })
    try {
      const acme = await poolAdapter.execute(
        buildQuery(source, ctx('acme'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(acme).toEqual([
        expect.objectContaining({ id: 'my-a', title: 'Acme', tenant_id: 'acme' }),
      ])
    } finally {
      await poolAdapter.dispose()
    }
  }, 90_000)
})

describe('tenancy migrate — mongodb (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string

  beforeAll(async () => {
    container = await new GenericContainer(CONTAINER_IMAGES.mongodb)
      .withExposedPorts(27017)
      .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(27017)
    connectionString = `mongodb://${host}:${port}/tenant_forge`

    const { MongoClient } = await import('mongodb')
    for (let i = 0; i < 30; i++) {
      try {
        const client = new MongoClient(connectionString)
        await client.connect()
        await client.db('tenant_forge').command({ ping: 1 })
        await client.close()
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  }, 120_000)

  afterAll(async () => {
    await container.stop()
  })

  it('migrates pool↔bridge with data move and canary A≠B', async () => {
    const source = poolAst('mo_pool')
    const target = bridgeAst('mo_bridge')
    await pushSchema(source, { dialect: 'mongodb', connectionString }, { tenants: [...TENANTS] })

    const adapter = createMongodbAdapter({ connectionString })
    try {
      await adapter.execute(
        buildQuery(source, ctx('acme'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 'mo-a', title: 'Acme' },
        }),
      )
      await adapter.execute(
        buildQuery(source, ctx('beta'), {
          operation: 'create',
          entity: 'Task',
          data: { id: 'mo-b', title: 'Beta' },
        }),
      )
    } finally {
      await adapter.dispose()
    }

    const toBridge = await migrateTenancy(
      target,
      { dialect: 'mongodb', connectionString },
      { tenants: [...TENANTS], from: source },
    )
    expect(toBridge.migrated.some((m) => m.rows >= 1)).toBe(true)

    const bridgeAdapter = createMongodbAdapter({ connectionString })
    try {
      const acme = await bridgeAdapter.execute(
        buildQuery(target, ctx('acme'), { operation: 'findMany', entity: 'Task' }),
      )
      const beta = await bridgeAdapter.execute(
        buildQuery(target, ctx('beta'), { operation: 'findMany', entity: 'Task' }),
      )
      expect(acme).toEqual([expect.objectContaining({ id: 'mo-a', title: 'Acme' })])
      expect(beta).toEqual([expect.objectContaining({ id: 'mo-b', title: 'Beta' })])
    } finally {
      await bridgeAdapter.dispose()
    }

    const back = await migrateTenancy(
      source,
      { dialect: 'mongodb', connectionString },
      { tenants: [...TENANTS], from: target },
    )
    expect(back.steps[0]?.to).toBe('shared-db-shared-schema')
  }, 90_000)
})
