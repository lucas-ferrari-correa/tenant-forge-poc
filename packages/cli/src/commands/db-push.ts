import type { ParsedArgs } from '../args.js'
import {
  resolveConnectionString,
  resolveDialect,
  resolveSchemaPath,
  resolveTenants,
} from '../args.js'
import { type CliDeps, formatPushResult, printJson, printLine } from '../output.js'
import { readSchema } from '../schema-file.js'

export async function runDbPush(deps: CliDeps, args: ParsedArgs): Promise<void> {
  const dialect = resolveDialect(args.values, deps.env)
  const connectionString = resolveConnectionString(args.values, deps.env)
  const source = readSchema(resolveSchemaPath(args.values, deps.cwd))
  const ast = deps.engine.parseSchema(source)

  const result = await deps.engine.pushSchema(
    ast,
    { dialect, connectionString },
    {
      tenants: resolveTenants(args.values),
      rlsSessionVar: args.values['rls-session-var'],
    },
  )

  if (args.values.json === true) {
    printJson(deps.out, result)
    return
  }
  printLine(deps.out, formatPushResult(result))
}
