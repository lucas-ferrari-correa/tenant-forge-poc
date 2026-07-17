import { describe, expect, it } from 'vitest'
import {
  DslParseError,
  parseSchema,
  type SchemaAst,
  SchemaValidationError,
  serializeSchema,
  validateSchema,
} from '../index.js'

const SINGLE_TENANT_SOURCE = `schema App {
  tenancy {
    model = "single-tenant"
  }
}

model Task {
  id Uuid @id @default(uuid())
  title String
  done Boolean @default(false)
  notes String?
  tags String[]
}
`

const POOL_SOURCE = `schema App {
  tenancy {
    model = "shared-db-shared-schema"
  }
}

model Task {
  id Uuid @id
  title String
  tenant_id Uuid @tenantId
}

model GeoIp {
  id Uuid @id
  cidr String
  @@global
}
`

const BRIDGE_SOURCE = `schema App {
  tenancy {
    model = "shared-db-isolated-schema"
  }
}

model Task {
  id Uuid @id
  title String
}
`

const HYBRID_SOURCE = `schema App {
  tenancy {
    model = "hybrid"
    defaultModel = "shared-db-shared-schema"
    binding entity AuditLog = "single-tenant"
    binding service billing = "shared-db-isolated-schema"
    binding tier enterprise = "single-tenant"
  }
}

model AuditLog {
  id Uuid @id
  event String
}

model Invoice {
  id Uuid @id
  amount Decimal
}

model Task {
  id Uuid @id
  title String
  tenant_id Uuid @tenantId
}

model Secret {
  id Uuid @id
  payload Bytes
  @@tenancy("single-tenant")
}

service billing {
  tenancy = "shared-db-isolated-schema"
  entities = [Invoice]
}
`

const RELATION_SOURCE = `schema App {
  tenancy {
    model = "single-tenant"
  }
}

model User {
  id Uuid @id
  email String @unique
}

model Project {
  id Uuid @id
  owner_id Uuid
  owner User @relation(kind = "many-to-one", fields = [owner_id], references = [id])
  mentor User? @relation(kind = "many-to-one", fields = [owner_id], references = [id])
}
`

describe('DSL parse — happy paths', () => {
  it('parses single-tenant schema with field modifiers and defaults', () => {
    const ast = parseSchema(SINGLE_TENANT_SOURCE)
    expect(ast.name).toBe('App')
    expect(ast.tenancy).toEqual({ model: 'single-tenant' })
    expect(ast.entities).toHaveLength(1)
    const task = ast.entities[0]
    expect(task?.name).toBe('Task')
    expect(task?.fields).toEqual([
      { name: 'id', type: 'Uuid', primaryKey: true, default: { kind: 'uuid' } },
      { name: 'title', type: 'String' },
      { name: 'done', type: 'Boolean', default: { kind: 'literal', value: false } },
      { name: 'notes', type: 'String', optional: true },
      { name: 'tags', type: 'String', list: true },
    ])
  })

  it('parses shared-schema (pool) with @tenantId and @@global', () => {
    const ast = parseSchema(POOL_SOURCE)
    expect(ast.tenancy.model).toBe('shared-db-shared-schema')
    const task = ast.entities.find((entity) => entity.name === 'Task')
    expect(task?.fields.some((field) => field.isTenantId === true)).toBe(true)
    const geo = ast.entities.find((entity) => entity.name === 'GeoIp')
    expect(geo?.global).toBe(true)
  })

  it('parses isolated-schema (bridge) without tenant_id', () => {
    const ast = parseSchema(BRIDGE_SOURCE)
    expect(ast.tenancy.model).toBe('shared-db-isolated-schema')
    expect(validateSchema(ast).ok).toBe(true)
  })

  it('parses hybrid tenancy with bindings, services, and @@tenancy', () => {
    const ast = parseSchema(HYBRID_SOURCE)
    expect(ast.tenancy.model).toBe('hybrid')
    if (ast.tenancy.model !== 'hybrid') {
      return
    }
    expect(ast.tenancy.defaultModel).toBe('shared-db-shared-schema')
    expect(ast.tenancy.bindings).toEqual([
      { scope: 'entity', name: 'AuditLog', model: 'single-tenant' },
      { scope: 'service', name: 'billing', model: 'shared-db-isolated-schema' },
      { scope: 'tier', name: 'enterprise', model: 'single-tenant' },
    ])
    expect(ast.services).toEqual([
      {
        name: 'billing',
        tenancyModel: 'shared-db-isolated-schema',
        entities: ['Invoice'],
      },
    ])
    const secret = ast.entities.find((entity) => entity.name === 'Secret')
    expect(secret?.tenancyModel).toBe('single-tenant')
  })

  it('parses relations into RelationDefinition (not scalar fields)', () => {
    const ast = parseSchema(RELATION_SOURCE)
    const project = ast.entities.find((entity) => entity.name === 'Project')
    expect(project?.fields.map((field) => field.name)).toEqual(['id', 'owner_id'])
    expect(project?.relations).toEqual([
      {
        name: 'owner',
        kind: 'many-to-one',
        target: 'User',
        fields: ['owner_id'],
        references: ['id'],
      },
      {
        name: 'mentor',
        kind: 'many-to-one',
        target: 'User',
        fields: ['owner_id'],
        references: ['id'],
        optional: true,
      },
    ])
  })
})

describe('DSL serialize', () => {
  it('serializes AST to canonical DSL text', () => {
    const ast: SchemaAst = {
      name: 'App',
      tenancy: { model: 'shared-db-shared-schema' },
      entities: [
        {
          name: 'Task',
          fields: [
            { name: 'id', type: 'Uuid', primaryKey: true },
            { name: 'title', type: 'String' },
            { name: 'tenant_id', type: 'Uuid', isTenantId: true },
          ],
        },
      ],
    }
    const text = serializeSchema(ast)
    expect(text).toContain('model = "shared-db-shared-schema"')
    expect(text).toContain('tenant_id Uuid @tenantId')
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('DSL round-trip', () => {
  it('is idempotent: source → AST → source → AST', () => {
    const sources = [
      SINGLE_TENANT_SOURCE,
      POOL_SOURCE,
      BRIDGE_SOURCE,
      HYBRID_SOURCE,
      RELATION_SOURCE,
    ]

    for (const source of sources) {
      const first = parseSchema(source)
      const serialized = serializeSchema(first)
      const second = parseSchema(serialized)
      expect(second).toEqual(first)
      expect(serializeSchema(second)).toBe(serialized)
    }
  })

  it('round-trips an AST built in memory', () => {
    const ast: SchemaAst = {
      name: 'Shop',
      tenancy: {
        model: 'hybrid',
        defaultModel: 'shared-db-shared-schema',
        bindings: [{ scope: 'entity', name: 'Ledger', model: 'single-tenant' }],
      },
      entities: [
        {
          name: 'Ledger',
          fields: [
            { name: 'id', type: 'Uuid', primaryKey: true, default: { kind: 'uuid' } },
            { name: 'label', type: 'String', unique: true },
          ],
        },
        {
          name: 'Order',
          fields: [
            { name: 'id', type: 'Int', primaryKey: true, default: { kind: 'autoincrement' } },
            { name: 'created_at', type: 'DateTime', default: { kind: 'now' } },
            { name: 'tenant_id', type: 'Uuid', isTenantId: true },
            { name: 'meta', type: 'Json', optional: true },
          ],
        },
      ],
    }
    const text = serializeSchema(ast)
    expect(parseSchema(text)).toEqual(ast)
  })
})

describe('DSL parse errors', () => {
  it('reports syntax errors with position', () => {
    expect(() => parseSchema('schema App {\n  tenancy {\n    model = \n  }\n}\n')).toThrow(
      DslParseError,
    )
    try {
      parseSchema('model Task { id Uuid @id }\n')
    } catch (error) {
      expect(error).toBeInstanceOf(DslParseError)
      if (error instanceof DslParseError) {
        expect(error.code).toBe('MISSING_SCHEMA')
      }
    }
  })

  it('rejects unknown tenancy model ids', () => {
    const source = `schema App {
  tenancy {
    model = "pool"
  }
}

model Task {
  id Uuid @id
}
`
    expect(() => parseSchema(source, { validate: false })).toThrow(DslParseError)
    try {
      parseSchema(source, { validate: false })
    } catch (error) {
      expect(error).toBeInstanceOf(DslParseError)
      if (error instanceof DslParseError) {
        expect(error.code).toBe('INVALID_TENANCY_MODEL')
        expect(error.position?.line).toBeGreaterThan(0)
      }
    }
  })

  it('rejects invalid tokens', () => {
    expect(() => parseSchema('schema App { tenancy { model = "single-tenant" } }\n@@@\n')).toThrow(
      DslParseError,
    )
  })

  it('surfaces AST validation after a structurally valid parse', () => {
    const source = `schema App {
  tenancy {
    model = "shared-db-shared-schema"
  }
}

model Task {
  id Uuid @id
  title String
}
`
    expect(() => parseSchema(source)).toThrow(SchemaValidationError)
    const unchecked = parseSchema(source, { validate: false })
    expect(validateSchema(unchecked).ok).toBe(false)
  })

  it('rejects relation fields without @relation', () => {
    const source = `schema App {
  tenancy {
    model = "single-tenant"
  }
}

model User {
  id Uuid @id
}

model Project {
  id Uuid @id
  owner User
}
`
    expect(() => parseSchema(source, { validate: false })).toThrow(DslParseError)
  })
})
