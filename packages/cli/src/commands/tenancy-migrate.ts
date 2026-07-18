import { resolve } from 'node:path'
import type { ConcreteTenancyModel, SchemaPullOptions } from '@tenant-forge/core'
import type { ParsedArgs } from '../args.js'
import {
  resolveAssumeTenancy,
  resolveConnectionString,
  resolveDialect,
  resolveEntityTenancy,
  resolveSchemaPath,
  resolveTenants,
} from '../args.js'
import { CliUsageError } from '../errors.js'
import { type CliDeps, formatMigrateResult, printJson, printLine } from '../output.js'
import { readSchema } from '../schema-file.js'

export async function runTenancyMigrate(deps: CliDeps, args: ParsedArgs): Promise<void> {
  const dialect = resolveDialect(args.values, deps.env)
  const connectionString = resolveConnectionString(args.values, deps.env)

  const tenants = resolveTenants(args.values)
  if (tenants === undefined) {
    throw new CliUsageError('tenancy migrate requires --tenants a,b,c')
  }

  const targetAst = deps.engine.parseSchema(readSchema(resolveSchemaPath(args.values, deps.cwd)))
  const from =
    args.values.from === undefined
      ? undefined
      : deps.engine.parseSchema(readSchema(resolve(deps.cwd, args.values.from)))

  const result = await deps.engine.migrateTenancy(
    targetAst,
    { dialect, connectionString },
    {
      tenants,
      from,
      dropSource: args.values['no-drop-source'] === true ? false : undefined,
      pull: buildPullHints(resolveAssumeTenancy(args.values), resolveEntityTenancy(args.values)),
      rlsSessionVar: args.values['rls-session-var'],
    },
  )

  if (args.values.json === true) {
    printJson(deps.out, result)
    return
  }
  printLine(deps.out, formatMigrateResult(result))
}

function buildPullHints(
  assumeTenancy: ConcreteTenancyModel | undefined,
  entityTenancy: Record<string, ConcreteTenancyModel | 'global'> | undefined,
): SchemaPullOptions | undefined {
  if (assumeTenancy === undefined && entityTenancy === undefined) return undefined
  return { assumeTenancy, entityTenancy }
}
