import { relative } from 'node:path'
import type { ParsedArgs } from '../args.js'
import { resolveSchemaPath } from '../args.js'
import { type CliDeps, printJson, printLine } from '../output.js'
import { readSchema } from '../schema-file.js'

export function runValidate(deps: CliDeps, args: ParsedArgs): void {
  const path = resolveSchemaPath(args.values, deps.cwd)
  const source = readSchema(path)

  // parseSchema runs assertValidSchema by default; throws DslParseError / SchemaValidationError.
  const ast = deps.engine.parseSchema(source)
  const shown = relative(deps.cwd, path) || path

  if (args.values.json === true) {
    printJson(deps.out, {
      valid: true,
      schema: ast.name,
      entities: ast.entities.map((e) => e.name),
    })
    return
  }
  printLine(deps.out, `${shown} is valid (${ast.entities.length} entities).`)
}
