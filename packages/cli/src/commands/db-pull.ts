import { writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { ParsedArgs } from '../args.js'
import {
  resolveAssumeTenancy,
  resolveConnectionString,
  resolveDialect,
  resolveEntityTenancy,
} from '../args.js'
import {
  type CliDeps,
  formatInferredTenancy,
  formatWarnings,
  printJson,
  printLine,
} from '../output.js'

export async function runDbPull(deps: CliDeps, args: ParsedArgs): Promise<void> {
  const dialect = resolveDialect(args.values, deps.env)
  const connectionString = resolveConnectionString(args.values, deps.env)

  const result = await deps.engine.pullSchema(
    { dialect, connectionString },
    {
      assumeTenancy: resolveAssumeTenancy(args.values),
      entityTenancy: resolveEntityTenancy(args.values),
      rlsSessionVar: args.values['rls-session-var'],
    },
  )

  const dsl = deps.engine.serializeSchema(result.ast)

  if (args.values.json === true) {
    printJson(deps.out, { dsl, inferred: result.inferred, warnings: result.warnings })
    return
  }

  const outPath = args.values.out
  if (outPath !== undefined) {
    const path = resolve(deps.cwd, outPath)
    writeFileSync(path, dsl.endsWith('\n') ? dsl : `${dsl}\n`, 'utf8')
    printLine(deps.out, `Wrote ${relative(deps.cwd, path) || path}`)
  } else {
    deps.out(dsl.endsWith('\n') ? dsl : `${dsl}\n`)
  }

  // Inference summary and warnings are informational; keep them off the DSL stream.
  printLine(deps.err, formatInferredTenancy(result.inferred))
  for (const line of formatWarnings(result.warnings)) {
    printLine(deps.err, line)
  }
}
