#!/usr/bin/env node
import { CORE_PACKAGE, coreVersion } from '@tenant-forge/core'

const args = process.argv.slice(2)

function printHelp(): void {
  console.log(`tenant-forge CLI (scaffold)

Usage: tenant-forge <command>

Commands (stubs — implemented in later phases):
  init              scaffold a schema file
  validate          validate schema
  generate          generate ORM client
  db push           apply schema to database
  db pull           introspect database → schema
  tenancy migrate   migrate tenancy model

Engine: ${CORE_PACKAGE}@${coreVersion()}
`)
}

if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
  printHelp()
  process.exit(0)
}

console.log(`[tenant-forge] command "${args[0]}" is not implemented yet (Phase 1 scaffold)`)
process.exit(0)
