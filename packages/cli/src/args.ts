import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type ConcreteTenancyModel, isConcreteTenancyModel } from '@tenant-forge/core'
import { CliUsageError } from './errors.js'

export const DIALECTS = ['postgres', 'mysql', 'mongodb'] as const
export type Dialect = (typeof DIALECTS)[number]

export const CLI_OPTIONS = {
  dialect: { type: 'string' },
  url: { type: 'string' },
  'connection-string': { type: 'string' },
  schema: { type: 'string' },
  tenants: { type: 'string' },
  'rls-session-var': { type: 'string' },
  from: { type: 'string' },
  'no-drop-source': { type: 'boolean' },
  'assume-tenancy': { type: 'string' },
  'entity-tenancy': { type: 'string', multiple: true },
  out: { type: 'string' },
  json: { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

export type ParsedArgs = ReturnType<
  typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true }>
>
export type CliValues = ParsedArgs['values']

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  try {
    return parseArgs({
      args: [...argv],
      options: CLI_OPTIONS,
      allowPositionals: true,
      strict: true,
    })
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error))
  }
}

export function resolveDialect(values: CliValues, env: NodeJS.ProcessEnv): Dialect {
  const raw = values.dialect ?? env.TENANT_FORGE_DIALECT
  if (raw === undefined) {
    throw new CliUsageError(
      'missing --dialect (or TENANT_FORGE_DIALECT); one of postgres|mysql|mongodb',
    )
  }
  if (!isDialect(raw)) {
    throw new CliUsageError(`invalid dialect "${raw}"; one of ${DIALECTS.join('|')}`)
  }
  return raw
}

function isDialect(value: string): value is Dialect {
  return (DIALECTS as readonly string[]).includes(value)
}

export function resolveConnectionString(values: CliValues, env: NodeJS.ProcessEnv): string {
  const url = values.url ?? values['connection-string'] ?? env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new CliUsageError('missing --url / --connection-string (or DATABASE_URL)')
  }
  return url
}

export function resolveSchemaPath(values: CliValues, cwd: string): string {
  return resolve(cwd, values.schema ?? 'schema.tf')
}

export function resolveTenants(values: CliValues): string[] | undefined {
  if (values.tenants === undefined) return undefined
  const tenants = values.tenants
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  return tenants.length > 0 ? tenants : undefined
}

export function resolveAssumeTenancy(values: CliValues): ConcreteTenancyModel | undefined {
  const raw = values['assume-tenancy']
  if (raw === undefined) return undefined
  if (!isConcreteTenancyModel(raw)) {
    throw new CliUsageError(`invalid --assume-tenancy "${raw}"; expected a concrete tenancy model`)
  }
  return raw
}

export function resolveEntityTenancy(
  values: CliValues,
): Record<string, ConcreteTenancyModel | 'global'> | undefined {
  const items = values['entity-tenancy']
  if (items === undefined || items.length === 0) return undefined
  const map: Record<string, ConcreteTenancyModel | 'global'> = {}
  for (const item of items) {
    const sep = item.indexOf('=')
    if (sep < 0) {
      throw new CliUsageError(`invalid --entity-tenancy "${item}"; expected Entity=model`)
    }
    const entity = item.slice(0, sep).trim()
    const model = item.slice(sep + 1).trim()
    if (entity.length === 0) {
      throw new CliUsageError(`invalid --entity-tenancy "${item}"; empty entity name`)
    }
    if (model !== 'global' && !isConcreteTenancyModel(model)) {
      throw new CliUsageError(`invalid --entity-tenancy "${item}"; unknown model "${model}"`)
    }
    map[entity] = model
  }
  return map
}
