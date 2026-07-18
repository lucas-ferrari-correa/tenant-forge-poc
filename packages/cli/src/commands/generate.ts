import { relative } from 'node:path'
import type { ParsedArgs } from '../args.js'
import { resolveSchemaPath } from '../args.js'
import { type CliDeps, printJson, printLine } from '../output.js'
import { readSchema } from '../schema-file.js'

const NOT_IMPLEMENTED =
  'code generation is not implemented yet; the typed ORM client is provided by @tenant-forge/sdk'

export function runGenerate(deps: CliDeps, args: ParsedArgs): void {
  const path = resolveSchemaPath(args.values, deps.cwd)
  const source = readSchema(path)
  const ast = deps.engine.parseSchema(source)
  const shown = relative(deps.cwd, path) || path

  if (args.values.json === true) {
    printJson(deps.out, { generated: false, schema: ast.name, message: NOT_IMPLEMENTED })
    return
  }
  printLine(deps.out, `${shown} is valid.`)
  printLine(deps.out, NOT_IMPLEMENTED)
}
