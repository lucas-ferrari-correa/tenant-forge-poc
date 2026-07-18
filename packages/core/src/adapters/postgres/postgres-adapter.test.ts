import pg from 'pg'
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildQuery,
  CONTAINER_IMAGES,
  createPostgresAdapter,
  createTenantContext,
  defineSchema,
  type EntityDefinition,
  type PostgresAdapter,
  type SchemaAst,
} from '../../index.js'

const { Client } = pg

const PG_USER = 'tenant'
const PG_PASSWORD = 'tenant'
const PG_DB = 'tenant_forge'

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

async function adminQuery(
  connectionString: string,
  text: string,
  values?: unknown[],
): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(text, values)
  } finally {
    await client.end()
  }
}

describe('postgres adapter — integration (testcontainers)', () => {
  let container: StartedTestContainer
  let connectionString: string
  let adapter: PostgresAdapter

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
    adapter = createPostgresAdapter({ connectionString })

    // --- pool fixture: shared table + RLS (FORCE so table owner is covered) ---
    await adminQuery(
      connectionString,
      `
      CREATE TABLE "Task" (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tenant_id TEXT NOT NULL
      );
      ALTER TABLE "Task" ENABLE ROW LEVEL SECURITY;
      ALTER TABLE "Task" FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON "Task"
        FOR ALL
        USING (tenant_id = current_setting('app.current_tenant_id', true))
        WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
      `,
    )

    // --- bridge fixture: schema-per-tenant tables (no tenant_id column) ---
    await adminQuery(
      connectionString,
      `
      CREATE SCHEMA tenant_acme;
      CREATE SCHEMA tenant_beta;
      CREATE TABLE tenant_acme."Task" (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
      CREATE TABLE tenant_beta."Task" (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
      `,
    )

    // --- silo fixture: dedicated databases ---
    await adminQuery(connectionString, 'CREATE DATABASE silo_acme')
    await adminQuery(connectionString, 'CREATE DATABASE silo_beta')
    for (const db of ['silo_acme', 'silo_beta'] as const) {
      const url = new URL(connectionString)
      url.pathname = `/${db}`
      await adminQuery(
        url.toString(),
        `
        CREATE TABLE "Task" (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL
        );
        `,
      )
    }

    // --- global fixture ---
    await adminQuery(
      connectionString,
      `
      CREATE TABLE "Country" (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL
      );
      `,
    )
  }, 120_000)

  afterAll(async () => {
    await adapter.dispose()
    await container.stop()
  })

  describe('pool (shared-db-shared-schema / tenant-id-filter + RLS)', () => {
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

      // Cross-tenant id lookup must not leak (WHERE id alone + wrong tenant context).
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

      // Beta must not update Acme's row.
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
    it('isolates via search_path — tenant A never reads tenant B (canary)', async () => {
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
