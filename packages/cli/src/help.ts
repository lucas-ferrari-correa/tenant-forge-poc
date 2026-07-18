export const HELP_TEXT = `tenant-forge — multi-tenant ORM engine CLI

Usage: tenant-forge <command> [options]

Commands:
  init                 scaffold a starter schema file (default schema.tf)
  validate             parse and validate a schema file
  generate             validate then report ORM client codegen status
  db push              forward-engineer the schema into a database
  db pull              introspect a database into a schema (infers tenancy)
  tenancy migrate      migrate a database between tenancy models (moves data)
  help                 show this help

Options:
  --dialect <postgres|mysql|mongodb>   target dialect (env TENANT_FORGE_DIALECT)
  --url, --connection-string <uri>     database connection (env DATABASE_URL)
  --schema <path>                      schema file (default schema.tf)
  --out <path>                         write pulled schema to a file (db pull)
  --tenants <a,b,c>                    tenant ids for push/migrate (CSV)
  --rls-session-var <name>             Postgres RLS session variable
  --from <path>                        explicit source schema (tenancy migrate)
  --no-drop-source                     keep source objects after migrate
  --assume-tenancy <model>             default model for ambiguous pull/migrate
  --entity-tenancy <Entity=model>      per-entity tenancy hint (repeatable)
  --force                              overwrite an existing file (init)
  --json                              emit structured JSON output
  -h, --help                          show this help

Exit codes:
  0  success
  1  engine/runtime error
  2  usage/validation error
`
