import { describe, expect, it } from 'vitest'
import {
  assertNoUntrustedTenantAuthority,
  assertValidSchema,
  createTenantContext,
  defineSchema,
  type EntityDefinition,
  InvalidTenantContextError,
  listConcreteModelsInSchema,
  requiresTenantIdColumn,
  resolveEntityTenancy,
  type SchemaAst,
  SchemaValidationError,
  TENANCY_MARKET_ALIAS,
  TENANCY_MODELS,
  tenantContextFromJwtClaim,
  UntrustedTenantAuthorityError,
  usesPhysicalIsolation,
  usesSchemaIsolation,
  validateSchema,
} from './index.js'

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
}): EntityDefinition {
  const fields = [idField(), { name: 'title', type: 'String' as const }]
  if (opts?.withTenantId === true) {
    fields.push(tenantIdField())
  }
  return {
    name: 'Task',
    fields,
    ...(opts?.global !== undefined ? { global: opts.global } : {}),
    ...(opts?.tenancyModel !== undefined ? { tenancyModel: opts.tenancyModel } : {}),
  }
}

describe('AST tenancy taxonomy', () => {
  it('exposes the four doc models and market aliases', () => {
    expect([...TENANCY_MODELS]).toEqual([
      'single-tenant',
      'shared-db-isolated-schema',
      'shared-db-shared-schema',
      'hybrid',
    ])
    expect(TENANCY_MARKET_ALIAS['single-tenant']).toBe('silo')
    expect(TENANCY_MARKET_ALIAS['shared-db-isolated-schema']).toBe('bridge')
    expect(TENANCY_MARKET_ALIAS['shared-db-shared-schema']).toBe('pool')
    expect(usesPhysicalIsolation('single-tenant')).toBe(true)
    expect(usesSchemaIsolation('shared-db-isolated-schema')).toBe(true)
    expect(requiresTenantIdColumn('shared-db-shared-schema')).toBe(true)
    expect(requiresTenantIdColumn('shared-db-isolated-schema')).toBe(false)
  })
})

describe('AST validate — structural invariants', () => {
  it('accepts a minimal single-tenant schema', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: { model: 'single-tenant' },
      entities: [taskEntity()],
    }
    expect(validateSchema(ast)).toEqual({ ok: true, issues: [] })
    expect(resolveEntityTenancy(ast, 'Task')).toBe('single-tenant')
  })

  it('rejects duplicate entities, fields, and missing primary key', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: { model: 'single-tenant' },
      entities: [
        {
          name: 'User',
          fields: [
            { name: 'email', type: 'String' },
            { name: 'email', type: 'String' },
          ],
        },
        {
          name: 'User',
          fields: [{ name: 'id', type: 'Uuid', primaryKey: true }],
        },
      ],
    }
    const result = validateSchema(ast)
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    const codes = result.issues.map((issue) => issue.code)
    expect(codes).toContain('DUPLICATE_ENTITY')
    expect(codes).toContain('DUPLICATE_FIELD')
    expect(codes).toContain('MISSING_PRIMARY_KEY')
  })

  it('rejects unknown relation targets and field/reference mismatches', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: { model: 'single-tenant' },
      entities: [
        {
          name: 'Project',
          fields: [idField(), { name: 'owner_id', type: 'Uuid' }],
          relations: [
            {
              name: 'owner',
              kind: 'many-to-one',
              target: 'MissingUser',
              fields: ['owner_id'],
              references: ['id'],
            },
            {
              name: 'broken',
              kind: 'many-to-one',
              target: 'Project',
              fields: ['owner_id'],
              references: ['id', 'extra'],
            },
          ],
        },
      ],
    }
    const result = validateSchema(ast)
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    const codes = result.issues.map((issue) => issue.code)
    expect(codes).toContain('UNKNOWN_RELATION_TARGET')
    expect(codes).toContain('RELATION_FIELD_MISMATCH')
  })

  it('accepts a valid relation between entities', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: { model: 'single-tenant' },
      entities: [
        {
          name: 'User',
          fields: [idField(), { name: 'name', type: 'String' }],
        },
        {
          name: 'Project',
          fields: [idField(), { name: 'owner_id', type: 'Uuid' }],
          relations: [
            {
              name: 'owner',
              kind: 'many-to-one',
              target: 'User',
              fields: ['owner_id'],
              references: ['id'],
            },
          ],
        },
      ],
    }
    expect(validateSchema(ast).ok).toBe(true)
  })
})

describe('AST validate — tenancy model invariants', () => {
  it('requires tenant_id on non-global entities under shared-schema (pool)', () => {
    const missing: SchemaAst = {
      name: 'app',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [taskEntity({ withTenantId: false })],
    }
    const missingResult = validateSchema(missing)
    expect(missingResult.ok).toBe(false)
    if (!missingResult.ok) {
      expect(missingResult.issues.some((issue) => issue.code === 'MISSING_TENANT_ID')).toBe(true)
    }

    const ok: SchemaAst = {
      name: 'app',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [taskEntity({ withTenantId: true })],
    }
    expect(validateSchema(ok).ok).toBe(true)
  })

  it('exempts global entities from tenant_id under pool', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'GeoIp',
          global: true,
          fields: [idField(), { name: 'cidr', type: 'String' }],
        },
        taskEntity({ withTenantId: true }),
      ],
    }
    expect(validateSchema(ast).ok).toBe(true)
  })

  it('rejects isTenantId under isolated-schema (bridge)', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: { model: 'shared-db-isolated-schema' },
      entities: [taskEntity({ withTenantId: true })],
    }
    const result = validateSchema(ast)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'FORBIDDEN_TENANT_ID')).toBe(true)
    }
  })

  it('accepts isolated-schema without tenant_id', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: { model: 'shared-db-isolated-schema' },
      entities: [taskEntity({ withTenantId: false })],
    }
    expect(validateSchema(ast).ok).toBe(true)
    expect(resolveEntityTenancy(ast, 'Task')).toBe('shared-db-isolated-schema')
  })

  it('rejects entity tenancy override on non-hybrid schemas', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: { model: 'single-tenant' },
      entities: [taskEntity({ tenancyModel: 'shared-db-shared-schema' })],
    }
    const result = validateSchema(ast)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'NON_HYBRID_ENTITY_OVERRIDE')).toBe(true)
    }
  })

  it('resolves hybrid bindings: entity > service > defaultModel', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: {
        model: 'hybrid',
        defaultModel: 'shared-db-shared-schema',
        bindings: [
          { scope: 'entity', name: 'AuditLog', model: 'single-tenant' },
          { scope: 'service', name: 'billing', model: 'shared-db-isolated-schema' },
        ],
      },
      services: [
        {
          name: 'billing',
          tenancyModel: 'shared-db-isolated-schema',
          entities: ['Invoice'],
        },
      ],
      entities: [
        {
          name: 'AuditLog',
          fields: [idField(), { name: 'event', type: 'String' }],
        },
        {
          name: 'Invoice',
          fields: [idField(), { name: 'amount', type: 'Decimal' }],
        },
        {
          name: 'Task',
          fields: [idField(), { name: 'title', type: 'String' }, tenantIdField()],
        },
      ],
    }

    expect(validateSchema(ast).ok).toBe(true)
    expect(resolveEntityTenancy(ast, 'AuditLog')).toBe('single-tenant')
    expect(resolveEntityTenancy(ast, 'Invoice')).toBe('shared-db-isolated-schema')
    expect(resolveEntityTenancy(ast, 'Task')).toBe('shared-db-shared-schema')
    expect(listConcreteModelsInSchema(ast).sort()).toEqual(
      ['shared-db-isolated-schema', 'shared-db-shared-schema', 'single-tenant'].sort(),
    )
  })

  it('fails hybrid entities that cannot resolve a concrete model', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: { model: 'hybrid', bindings: [] },
      entities: [taskEntity()],
    }
    const result = validateSchema(ast)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code === 'HYBRID_UNRESOLVABLE_ENTITY')).toBe(true)
    }
  })

  it('honors entity-level tenancyModel under hybrid before default', () => {
    const ast: SchemaAst = {
      name: 'app',
      tenancy: {
        model: 'hybrid',
        defaultModel: 'shared-db-shared-schema',
        bindings: [],
      },
      entities: [
        {
          name: 'Secret',
          tenancyModel: 'single-tenant',
          fields: [idField(), { name: 'payload', type: 'Bytes' }],
        },
      ],
    }
    expect(validateSchema(ast).ok).toBe(true)
    expect(resolveEntityTenancy(ast, 'Secret')).toBe('single-tenant')
  })
})

describe('AST assert / defineSchema', () => {
  it('assertValidSchema throws SchemaValidationError with issues', () => {
    const ast: SchemaAst = {
      name: '',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [taskEntity({ withTenantId: false })],
    }
    expect(() => assertValidSchema(ast)).toThrow(SchemaValidationError)
    try {
      assertValidSchema(ast)
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationError)
      if (error instanceof SchemaValidationError) {
        expect(error.issues.length).toBeGreaterThan(0)
      }
    }
  })

  it('defineSchema freezes a valid AST', () => {
    const ast = defineSchema({
      name: 'app',
      tenancy: { model: 'single-tenant' },
      entities: [taskEntity()],
    })
    expect(Object.isFrozen(ast)).toBe(true)
    expect(Object.isFrozen(ast.entities[0])).toBe(true)
  })
})

describe('TenantContext — trusted derivation only', () => {
  it('creates context from jwt claim and verified sources', () => {
    const ctx = tenantContextFromJwtClaim('org_abc')
    expect(ctx.tenantId).toBe('org_abc')
    expect(ctx.source).toBe('jwt-claim')
    expect(Object.isFrozen(ctx)).toBe(true)

    const session = createTenantContext({
      tenantId: '  org_xyz  ',
      source: 'verified-session',
    })
    expect(session.tenantId).toBe('org_xyz')
  })

  it('rejects empty tenantId', () => {
    expect(() => createTenantContext({ tenantId: '   ', source: 'jwt-claim' })).toThrow(
      InvalidTenantContextError,
    )
  })

  it('refuses client-supplied tenant channels as authority', () => {
    expect(() => assertNoUntrustedTenantAuthority({ header: 'org_evil' })).toThrow(
      UntrustedTenantAuthorityError,
    )
    expect(() => assertNoUntrustedTenantAuthority({ queryParam: 't1' })).toThrow(
      UntrustedTenantAuthorityError,
    )
    expect(() => assertNoUntrustedTenantAuthority({ bodyField: 't1' })).toThrow(
      UntrustedTenantAuthorityError,
    )
    expect(() => assertNoUntrustedTenantAuthority({})).not.toThrow()
    expect(() => assertNoUntrustedTenantAuthority({ header: '  ' })).not.toThrow()
  })
})
