import { describe, expect, it } from 'vitest'
import {
  buildQuery,
  createQueryBuilder,
  createTenantContext,
  defineSchema,
  type EntityDefinition,
  QUERY_OPERATIONS,
  QueryBuildError,
  type SchemaAst,
  TENANT_ID_FIELD_NAME,
  tenantContextFromJwtClaim,
} from '../index.js'

function idField(): EntityDefinition['fields'][number] {
  return { name: 'id', type: 'Uuid', primaryKey: true }
}

function tenantIdField(): EntityDefinition['fields'][number] {
  return { name: 'tenant_id', type: 'Uuid', isTenantId: true }
}

function taskEntity(opts?: {
  withTenantId?: boolean
  global?: boolean
  tenancyModel?: EntityDefinition['tenancyModel']
  name?: string
}): EntityDefinition {
  const fields = [idField(), { name: 'title', type: 'String' as const }]
  if (opts?.withTenantId === true) {
    fields.push(tenantIdField())
  }
  return {
    name: opts?.name ?? 'Task',
    fields,
    ...(opts?.global !== undefined ? { global: opts.global } : {}),
    ...(opts?.tenancyModel !== undefined ? { tenancyModel: opts.tenancyModel } : {}),
  }
}

function trustedContext(tenantId = 'acme-corp') {
  return createTenantContext({ tenantId, source: 'jwt-claim' })
}

describe('queryBuilder — IR shape (dialect-agnostic)', () => {
  it('exposes POC operations and builds IR without dialect fields', () => {
    expect([...QUERY_OPERATIONS]).toEqual(['findMany', 'findFirst', 'create', 'update', 'delete'])

    const ast = defineSchema({
      name: 'app',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [taskEntity({ withTenantId: true })],
    })
    const ir = buildQuery(ast, trustedContext('t1'), {
      operation: 'findMany',
      entity: 'Task',
      where: { title: 'x' },
    })

    expect(ir.operation).toBe('findMany')
    expect(ir.entity).toBe('Task')
    expect(Object.keys(ir).sort()).toEqual(
      ['entity', 'isolation', 'operation', 'tenancyModel', 'where'].sort(),
    )
    expect(ir).not.toHaveProperty('sql')
    expect(ir).not.toHaveProperty('mongo')
    expect(ir).not.toHaveProperty('dialect')
    expect(ir.isolation).not.toHaveProperty('sql')
  })
})

describe('queryBuilder — four concrete models', () => {
  it('pool (shared-db-shared-schema): injects tenant_id filter + RLS/mongo hints', () => {
    const ast = defineSchema({
      name: 'pool',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [taskEntity({ withTenantId: true })],
    })
    const ctx = tenantContextFromJwtClaim('tenant-a')
    const ir = buildQuery(ast, ctx, {
      operation: 'findFirst',
      entity: 'Task',
      where: { title: 'hello' },
    })

    expect(ir.tenancyModel).toBe('shared-db-shared-schema')
    expect(ir.isolation).toEqual({
      kind: 'tenant-id-filter',
      tenantId: 'tenant-a',
      fieldName: TENANT_ID_FIELD_NAME,
      rls: { sessionVar: 'app.current_tenant_id' },
      mongo: { shardKey: TENANT_ID_FIELD_NAME },
    })
    expect(ir.where).toEqual({ title: 'hello', tenant_id: 'tenant-a' })
  })

  it('pool create/update injects tenant_id into data from context', () => {
    const ast = defineSchema({
      name: 'pool',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [taskEntity({ withTenantId: true })],
    })
    const ctx = trustedContext('tenant-b')
    const createIr = buildQuery(ast, ctx, {
      operation: 'create',
      entity: 'Task',
      data: { title: 'new' },
    })
    expect(createIr.data).toEqual({ title: 'new', tenant_id: 'tenant-b' })

    const updateIr = buildQuery(ast, ctx, {
      operation: 'update',
      entity: 'Task',
      where: { id: '1' },
      data: { title: 'upd' },
    })
    expect(updateIr.where).toEqual({ id: '1', tenant_id: 'tenant-b' })
    expect(updateIr.data).toEqual({ title: 'upd', tenant_id: 'tenant-b' })
  })

  it('bridge (shared-db-isolated-schema): schema-per-tenant, no tenant_id column', () => {
    const ast = defineSchema({
      name: 'bridge',
      tenancy: { model: 'shared-db-isolated-schema' },
      entities: [taskEntity()],
    })
    const ir = buildQuery(ast, trustedContext('Acme Corp!'), {
      operation: 'findMany',
      entity: 'Task',
      where: { title: 'x' },
    })

    expect(ir.tenancyModel).toBe('shared-db-isolated-schema')
    expect(ir.isolation).toEqual({
      kind: 'schema-per-tenant',
      tenantId: 'Acme Corp!',
      schemaName: 'tenant_acme_corp',
    })
    expect(ir.where).toEqual({ title: 'x' })
    expect(ir.where).not.toHaveProperty('tenant_id')
  })

  it('silo (single-tenant): database-per-tenant slot + mongo hint', () => {
    const ast = defineSchema({
      name: 'silo',
      tenancy: { model: 'single-tenant' },
      entities: [taskEntity()],
    })
    const ir = buildQuery(ast, trustedContext('enterprise-1'), {
      operation: 'delete',
      entity: 'Task',
      where: { id: '9' },
    })

    expect(ir.tenancyModel).toBe('single-tenant')
    expect(ir.isolation).toEqual({
      kind: 'database-per-tenant',
      tenantId: 'enterprise-1',
      databaseName: 'tenant_enterprise_1',
      mongo: { databasePerTenant: true },
    })
    expect(ir.where).toEqual({ id: '9' })
    expect(ir.where).not.toHaveProperty('tenant_id')
  })
})

describe('queryBuilder — hybrid resolution', () => {
  it('resolves per-entity concrete models and emits matching isolation', () => {
    const ast = defineSchema({
      name: 'hybrid',
      tenancy: {
        model: 'hybrid',
        bindings: [
          { scope: 'entity', name: 'PoolTask', model: 'shared-db-shared-schema' },
          { scope: 'entity', name: 'BridgeTask', model: 'shared-db-isolated-schema' },
        ],
        defaultModel: 'single-tenant',
      },
      entities: [
        taskEntity({ name: 'PoolTask', withTenantId: true }),
        taskEntity({ name: 'BridgeTask' }),
        taskEntity({ name: 'SiloTask' }),
      ],
    })
    const ctx = trustedContext('h1')
    const qb = createQueryBuilder(ast, ctx)

    const pool = qb.build({ operation: 'findMany', entity: 'PoolTask' })
    expect(pool.tenancyModel).toBe('shared-db-shared-schema')
    expect(pool.isolation.kind).toBe('tenant-id-filter')

    const bridge = qb.build({ operation: 'findMany', entity: 'BridgeTask' })
    expect(bridge.tenancyModel).toBe('shared-db-isolated-schema')
    expect(bridge.isolation.kind).toBe('schema-per-tenant')

    const silo = qb.build({ operation: 'findMany', entity: 'SiloTask' })
    expect(silo.tenancyModel).toBe('single-tenant')
    expect(silo.isolation.kind).toBe('database-per-tenant')
  })
})

describe('queryBuilder — global entities', () => {
  it('emits isolation none and does not inject tenant_id', () => {
    const ast = defineSchema({
      name: 'app',
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
    const ir = buildQuery(ast, trustedContext('t1'), {
      operation: 'findMany',
      entity: 'Country',
      where: { code: 'BR' },
    })
    expect(ir.tenancyModel).toBe('global')
    expect(ir.isolation).toEqual({ kind: 'none' })
    expect(ir.where).toEqual({ code: 'BR' })
    expect(ir.where).not.toHaveProperty('tenant_id')
  })
})

describe('queryBuilder — fail-closed security', () => {
  it('rejects client tenant_id in where or data', () => {
    const ast = defineSchema({
      name: 'pool',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [taskEntity({ withTenantId: true })],
    })
    const ctx = trustedContext('real')

    expect(() =>
      buildQuery(ast, ctx, {
        operation: 'findMany',
        entity: 'Task',
        where: { tenant_id: 'evil' },
      }),
    ).toThrow(QueryBuildError)

    try {
      buildQuery(ast, ctx, {
        operation: 'create',
        entity: 'Task',
        data: { title: 'x', tenant_id: 'evil' },
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(QueryBuildError)
      if (error instanceof QueryBuildError) {
        expect(error.code).toBe('CLIENT_TENANT_ID_FORBIDDEN')
      }
    }
  })

  it('rejects untrusted client channels when provided', () => {
    const ast = defineSchema({
      name: 'pool',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [taskEntity({ withTenantId: true })],
    })
    expect(() =>
      buildQuery(
        ast,
        trustedContext(),
        { operation: 'findMany', entity: 'Task' },
        { untrustedInput: { header: 'spoofed-tenant' } },
      ),
    ).toThrow(QueryBuildError)

    try {
      buildQuery(
        ast,
        trustedContext(),
        { operation: 'findMany', entity: 'Task' },
        { untrustedInput: { queryParam: 'x' } },
      )
    } catch (error) {
      expect(error).toBeInstanceOf(QueryBuildError)
      if (error instanceof QueryBuildError) {
        expect(error.code).toBe('UNTRUSTED_TENANT_AUTHORITY')
      }
    }
  })

  it('rejects invalid tenant context source', () => {
    const ast = defineSchema({
      name: 'silo',
      tenancy: { model: 'single-tenant' },
      entities: [taskEntity()],
    })
    const forged = { tenantId: 'x', source: 'client-header' } as unknown as ReturnType<
      typeof trustedContext
    >
    expect(() => buildQuery(ast, forged, { operation: 'findMany', entity: 'Task' })).toThrow(
      QueryBuildError,
    )
  })

  it('rejects unknown entity and unresolvable hybrid tenancy', () => {
    const poolAst = defineSchema({
      name: 'pool',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [taskEntity({ withTenantId: true })],
    })
    try {
      buildQuery(poolAst, trustedContext(), {
        operation: 'findMany',
        entity: 'Missing',
      })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(QueryBuildError)
      if (error instanceof QueryBuildError) {
        expect(error.code).toBe('UNKNOWN_ENTITY')
      }
    }

    const hybridAst: SchemaAst = {
      name: 'broken',
      tenancy: { model: 'hybrid', bindings: [] },
      entities: [taskEntity({ withTenantId: true })],
    }
    expect(() =>
      buildQuery(hybridAst, trustedContext(), {
        operation: 'findMany',
        entity: 'Task',
      }),
    ).toThrow(QueryBuildError)
  })
})
