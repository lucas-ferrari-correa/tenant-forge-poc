import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseSchema,
  type SchemaAst,
  type SchemaPullResult,
  type SchemaPushResult,
  serializeSchema,
  type TenancyMigrateOptions,
  type TenancyMigrateResult,
  type TenancyMigrateTarget,
} from '@tenant-forge/core'
import { describe, expect, it } from 'vitest'
import type { Engine } from './engine.js'
import type { CliDeps } from './output.js'
import { run } from './run.js'

const POOL_SCHEMA = `schema App {
  tenancy {
    model = "shared-db-shared-schema"
  }
}

model Customer {
  id Uuid @id
  name String
  tenant_id Uuid @tenantId
}
`

type Harness = {
  deps: CliDeps
  out: () => string
  err: () => string
  calls: EngineCalls
}

type EngineCalls = {
  push: Array<{ ast: SchemaAst; target: unknown; options: unknown }>
  pull: Array<{ target: unknown; options: unknown }>
  migrate: Array<{ ast: SchemaAst; target: TenancyMigrateTarget; options: TenancyMigrateOptions }>
}

const PUSH_RESULT: SchemaPushResult = {
  dialect: 'postgres',
  created: [{ kind: 'table', name: 'Customer', tenancyModel: 'shared-db-shared-schema' }],
  warnings: ['sample warning'],
}

function makeEngine(calls: EngineCalls, overrides: Partial<Engine> = {}): Engine {
  return {
    parseSchema,
    serializeSchema,
    async pushSchema(ast, target, options) {
      calls.push.push({ ast, target, options })
      return PUSH_RESULT
    },
    async pullSchema(target, options) {
      calls.pull.push({ target, options })
      const pulled: SchemaPullResult = {
        dialect: 'postgres',
        ast: parseSchema(POOL_SCHEMA),
        inferred: [
          { entity: 'Customer', model: 'shared-db-shared-schema', signals: ['tenant_id'] },
        ],
        warnings: [],
      }
      return pulled
    },
    async migrateTenancy(ast, target, options) {
      calls.migrate.push({ ast, target, options })
      const result: TenancyMigrateResult = {
        dialect: 'postgres',
        steps: [
          {
            entity: 'Customer',
            from: 'single-tenant',
            to: 'shared-db-shared-schema',
            action: 'migrate',
          },
        ],
        migrated: [{ entity: 'Customer', tenant: 'acme', rows: 3 }],
        warnings: [],
      }
      return result
    },
    ...overrides,
  }
}

function harness(env: NodeJS.ProcessEnv = {}, overrides: Partial<Engine> = {}): Harness {
  const cwd = mkdtempSync(join(tmpdir(), 'tf-cli-'))
  const calls: EngineCalls = { push: [], pull: [], migrate: [] }
  let out = ''
  let err = ''
  const deps: CliDeps = {
    engine: makeEngine(calls, overrides),
    out: (t) => {
      out += t
    },
    err: (t) => {
      err += t
    },
    env,
    cwd,
  }
  return { deps, out: () => out, err: () => err, calls }
}

function writeSchema(cwd: string, content = POOL_SCHEMA, name = 'schema.tf'): string {
  const path = join(cwd, name)
  writeFileSync(path, content, 'utf8')
  return path
}

describe('cli dispatcher', () => {
  it('prints help and exits 0 with no arguments', async () => {
    const h = harness()
    const code = await run([], h.deps)
    expect(code).toBe(0)
    expect(h.out()).toContain('Usage: tenant-forge')
    expect(h.out()).toContain('tenancy migrate')
  })

  it('prints help for the help command and for --help', async () => {
    const h = harness()
    expect(await run(['help'], h.deps)).toBe(0)
    expect(await run(['--help'], h.deps)).toBe(0)
    expect(h.out()).toContain('Exit codes:')
  })

  it('rejects an unknown command with exit 2', async () => {
    const h = harness()
    const code = await run(['frobnicate'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('unknown command')
  })

  it('rejects an unknown flag with exit 2', async () => {
    const h = harness()
    const code = await run(['validate', '--nope'], h.deps)
    expect(code).toBe(2)
  })

  it('requires a db subcommand', async () => {
    const h = harness()
    const code = await run(['db'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('push | pull')
  })

  it('requires a tenancy subcommand', async () => {
    const h = harness()
    const code = await run(['tenancy'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('migrate')
  })
})

describe('init', () => {
  it('scaffolds a valid schema file', async () => {
    const h = harness()
    const code = await run(['init'], h.deps)
    expect(code).toBe(0)
    const written = readFileSync(join(h.deps.cwd, 'schema.tf'), 'utf8')
    expect(() => parseSchema(written)).not.toThrow()
    expect(h.out()).toContain('Created schema.tf')
  })

  it('refuses to overwrite an existing file without --force', async () => {
    const h = harness()
    writeSchema(h.deps.cwd, 'existing')
    const code = await run(['init'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('--force')
    expect(readFileSync(join(h.deps.cwd, 'schema.tf'), 'utf8')).toBe('existing')
  })

  it('overwrites with --force', async () => {
    const h = harness()
    writeSchema(h.deps.cwd, 'existing')
    const code = await run(['init', '--force'], h.deps)
    expect(code).toBe(0)
    expect(readFileSync(join(h.deps.cwd, 'schema.tf'), 'utf8')).toContain('schema App')
  })

  it('honors a custom --schema path', async () => {
    const h = harness()
    const code = await run(['init', '--schema', 'nested/model.tf'], h.deps)
    // Directory does not exist → engine-independent FS error surfaces as runtime (1).
    expect(code).toBe(1)
  })
})

describe('validate', () => {
  it('reports a valid schema', async () => {
    const h = harness()
    writeSchema(h.deps.cwd)
    const code = await run(['validate'], h.deps)
    expect(code).toBe(0)
    expect(h.out()).toContain('is valid')
  })

  it('emits JSON when --json is set', async () => {
    const h = harness()
    writeSchema(h.deps.cwd)
    const code = await run(['validate', '--json'], h.deps)
    expect(code).toBe(0)
    const parsed = JSON.parse(h.out())
    expect(parsed).toMatchObject({ valid: true, schema: 'App', entities: ['Customer'] })
  })

  it('maps a parse error to exit 2', async () => {
    const h = harness()
    writeSchema(h.deps.cwd, 'schema App { this is broken')
    const code = await run(['validate'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('DSL parse error')
  })

  it('maps a missing file to exit 2', async () => {
    const h = harness()
    const code = await run(['validate'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('cannot read schema')
  })
})

describe('generate', () => {
  it('validates and reports codegen is not implemented', async () => {
    const h = harness()
    writeSchema(h.deps.cwd)
    const code = await run(['generate'], h.deps)
    expect(code).toBe(0)
    expect(h.out()).toContain('@tenant-forge/sdk')
  })

  it('fails on an invalid schema with exit 2', async () => {
    const h = harness()
    writeSchema(h.deps.cwd, 'schema App { nope')
    const code = await run(['generate'], h.deps)
    expect(code).toBe(2)
  })
})

describe('db push', () => {
  it('parses the schema and calls pushSchema with resolved target/options', async () => {
    const h = harness()
    writeSchema(h.deps.cwd)
    const code = await run(
      [
        'db',
        'push',
        '--dialect',
        'postgres',
        '--url',
        'postgres://x',
        '--tenants',
        'acme, globex ',
        '--rls-session-var',
        'app.tid',
      ],
      h.deps,
    )
    expect(code).toBe(0)
    expect(h.calls.push).toHaveLength(1)
    expect(h.calls.push[0]?.target).toEqual({
      dialect: 'postgres',
      connectionString: 'postgres://x',
    })
    expect(h.calls.push[0]?.options).toEqual({
      tenants: ['acme', 'globex'],
      rlsSessionVar: 'app.tid',
    })
    expect(h.out()).toContain('+ table Customer')
    expect(h.out()).toContain('sample warning')
  })

  it('falls back to env for dialect and url', async () => {
    const h = harness({ TENANT_FORGE_DIALECT: 'mysql', DATABASE_URL: 'mysql://y' })
    writeSchema(h.deps.cwd)
    const code = await run(['db', 'push'], h.deps)
    expect(code).toBe(0)
    expect(h.calls.push[0]?.target).toEqual({ dialect: 'mysql', connectionString: 'mysql://y' })
  })

  it('emits the raw engine result with --json', async () => {
    const h = harness({ TENANT_FORGE_DIALECT: 'postgres', DATABASE_URL: 'postgres://x' })
    writeSchema(h.deps.cwd)
    const code = await run(['db', 'push', '--json'], h.deps)
    expect(code).toBe(0)
    expect(JSON.parse(h.out())).toEqual(PUSH_RESULT)
  })

  it('requires --dialect', async () => {
    const h = harness()
    writeSchema(h.deps.cwd)
    const code = await run(['db', 'push', '--url', 'postgres://x'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('--dialect')
    expect(h.calls.push).toHaveLength(0)
  })

  it('requires a connection string', async () => {
    const h = harness()
    writeSchema(h.deps.cwd)
    const code = await run(['db', 'push', '--dialect', 'postgres'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('--url')
  })

  it('rejects an invalid dialect with exit 2', async () => {
    const h = harness()
    writeSchema(h.deps.cwd)
    const code = await run(['db', 'push', '--dialect', 'oracle', '--url', 'x'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('invalid dialect')
  })

  it('maps an engine failure to exit 1', async () => {
    const h = harness(
      { TENANT_FORGE_DIALECT: 'postgres', DATABASE_URL: 'postgres://x' },
      {
        async pushSchema() {
          throw new Error('connection refused')
        },
      },
    )
    writeSchema(h.deps.cwd)
    const code = await run(['db', 'push'], h.deps)
    expect(code).toBe(1)
    expect(h.err()).toContain('connection refused')
  })
})

describe('db pull', () => {
  it('serializes the pulled AST to stdout and inference to stderr', async () => {
    const h = harness({ TENANT_FORGE_DIALECT: 'postgres', DATABASE_URL: 'postgres://x' })
    const code = await run(['db', 'pull'], h.deps)
    expect(code).toBe(0)
    expect(h.out()).toContain('schema App')
    expect(h.err()).toContain('Inferred tenancy')
    expect(h.err()).toContain('Customer: shared-db-shared-schema')
  })

  it('writes to --out and forwards pull hints', async () => {
    const h = harness({ TENANT_FORGE_DIALECT: 'postgres', DATABASE_URL: 'postgres://x' })
    const code = await run(
      [
        'db',
        'pull',
        '--out',
        'pulled.tf',
        '--assume-tenancy',
        'single-tenant',
        '--entity-tenancy',
        'Customer=global',
      ],
      h.deps,
    )
    expect(code).toBe(0)
    expect(readFileSync(join(h.deps.cwd, 'pulled.tf'), 'utf8')).toContain('schema App')
    expect(h.calls.pull[0]?.options).toMatchObject({
      assumeTenancy: 'single-tenant',
      entityTenancy: { Customer: 'global' },
    })
    expect(h.out()).toContain('Wrote pulled.tf')
  })

  it('rejects a malformed --entity-tenancy with exit 2', async () => {
    const h = harness({ TENANT_FORGE_DIALECT: 'postgres', DATABASE_URL: 'postgres://x' })
    const code = await run(['db', 'pull', '--entity-tenancy', 'Customer'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('Entity=model')
  })
})

describe('tenancy migrate', () => {
  it('parses the target schema and calls migrateTenancy', async () => {
    const h = harness({ TENANT_FORGE_DIALECT: 'postgres', DATABASE_URL: 'postgres://x' })
    writeSchema(h.deps.cwd)
    const code = await run(['tenancy', 'migrate', '--tenants', 'acme'], h.deps)
    expect(code).toBe(0)
    expect(h.calls.migrate).toHaveLength(1)
    expect(h.calls.migrate[0]?.options.tenants).toEqual(['acme'])
    expect(h.calls.migrate[0]?.options.dropSource).toBeUndefined()
    expect(h.out()).toContain('Customer: single-tenant -> shared-db-shared-schema')
    expect(h.out()).toContain('Customer/acme: 3 rows')
  })

  it('requires --tenants', async () => {
    const h = harness({ TENANT_FORGE_DIALECT: 'postgres', DATABASE_URL: 'postgres://x' })
    writeSchema(h.deps.cwd)
    const code = await run(['tenancy', 'migrate'], h.deps)
    expect(code).toBe(2)
    expect(h.err()).toContain('--tenants')
    expect(h.calls.migrate).toHaveLength(0)
  })

  it('passes --no-drop-source and an explicit --from schema', async () => {
    const h = harness({ TENANT_FORGE_DIALECT: 'postgres', DATABASE_URL: 'postgres://x' })
    writeSchema(h.deps.cwd)
    writeSchema(h.deps.cwd, POOL_SCHEMA, 'from.tf')
    const code = await run(
      ['tenancy', 'migrate', '--tenants', 'acme', '--no-drop-source', '--from', 'from.tf'],
      h.deps,
    )
    expect(code).toBe(0)
    expect(h.calls.migrate[0]?.options.dropSource).toBe(false)
    expect(h.calls.migrate[0]?.options.from).toBeDefined()
  })
})
