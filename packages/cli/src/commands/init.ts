import { existsSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import type { ParsedArgs } from '../args.js'
import { resolveSchemaPath } from '../args.js'
import { CliUsageError } from '../errors.js'
import { type CliDeps, printJson, printLine } from '../output.js'

const DEFAULT_SCHEMA = `schema App {
  tenancy {
    model = "shared-db-shared-schema"
  }
}

model Customer {
  id Uuid @id @default(uuid())
  name String
  email String @unique
  tenant_id Uuid @tenantId
}
`

export function runInit(deps: CliDeps, args: ParsedArgs): void {
  const path = resolveSchemaPath(args.values, deps.cwd)
  const force = args.values.force === true

  if (existsSync(path) && !force) {
    throw new CliUsageError(`schema already exists at ${path}; pass --force to overwrite`)
  }

  writeFileSync(path, DEFAULT_SCHEMA, 'utf8')
  const shown = relative(deps.cwd, path) || path

  if (args.values.json === true) {
    printJson(deps.out, { created: path })
    return
  }
  printLine(deps.out, `Created ${shown}`)
}
