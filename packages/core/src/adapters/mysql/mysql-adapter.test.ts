import mysql from 'mysql2/promise'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildQuery,
  CONTAINER_IMAGES,
  createMysqlAdapter,
  createTenantContext,
  defineSchema,
  type EntityDefinition,
  type MysqlAdapter,
  type SchemaAst,
} from '../../index.js'

const MYSQL_ROOT_PASSWORD = 'root'
const MYSQL_DB = 'tenant_forge'

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

async function adminQuery(connectionString: string, text: string): Promise<void> {
  const connection = await mysql.createConnection(connectionString)
  try {
    await connection.execute(text)
  } finally {
    await connection.end()
  }
}

async function waitForMysql(connectionString: string): Promise<void> {
  const deadline = Date.now() + 90_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const connection = await mysql.createConnection(connectionString)
      try {
        await connection.ping()
      } finally {
        await connection.end()
      }
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  throw new Error(`MySQL did not become ready: ${String(lastError)}`)
}

describe('mysql adapter — integration (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string
  let adapter: MysqlAdapter

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
    adapter = createMysqlAdapter({ connectionString })

    // --- pool fixture: shared table (no RLS — MySQL isolation = IR tenant_id filter) ---
    await adminQuery(
      connectionString,
      `
      CREATE TABLE \`Task\` (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        tenant_id VARCHAR(64) NOT NULL
      )
      `,
    )

    // --- bridge fixture: database-per-tenant tables (MySQL database ≈ schema) ---
    await adminQuery(connectionString, 'CREATE DATABASE `tenant_acme`')
    await adminQuery(connectionString, 'CREATE DATABASE `tenant_beta`')
    await adminQuery(
      connectionString,
      `
      CREATE TABLE \`tenant_acme\`.\`Task\` (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL
      )
      `,
    )
    await adminQuery(
      connectionString,
      `
      CREATE TABLE \`tenant_beta\`.\`Task\` (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL
      )
      `,
    )

    // --- silo fixture: dedicated databases (`silo_${slug}`, distinct from bridge) ---
    await adminQuery(connectionString, 'CREATE DATABASE `silo_acme`')
    await adminQuery(connectionString, 'CREATE DATABASE `silo_beta`')
    await adminQuery(
      connectionString,
      `
      CREATE TABLE \`silo_acme\`.\`Task\` (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL
      )
      `,
    )
    await adminQuery(
      connectionString,
      `
      CREATE TABLE \`silo_beta\`.\`Task\` (
        id VARCHAR(64) PRIMARY KEY,
        title VARCHAR(255) NOT NULL
      )
      `,
    )

    // --- global fixture ---
    await adminQuery(
      connectionString,
      `
      CREATE TABLE \`Country\` (
        id VARCHAR(64) PRIMARY KEY,
        code VARCHAR(8) NOT NULL
      )
      `,
    )
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
    it('isolates via qualified database — tenant A never reads tenant B (canary)', async () => {
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
      await adminQuery(connectionString, 'TRUNCATE TABLE `silo_acme`.`Task`')
      await adminQuery(connectionString, 'TRUNCATE TABLE `silo_beta`.`Task`')
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
