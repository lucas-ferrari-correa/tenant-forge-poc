import type { SchemaAst } from '../ast/types.js'
import { assertValidSchema } from '../ast/validate.js'
import { SchemaPushError } from './errors.js'
import { pushMongodbSchema } from './mongodb.js'
import { pushMysqlSchema } from './mysql.js'
import { buildPushPlan } from './plan.js'
import { pushPostgresSchema } from './postgres.js'
import type { SchemaPushOptions, SchemaPushResult, SchemaPushTarget } from './types.js'

export type SchemaPusher = {
  push(ast: SchemaAst, options?: SchemaPushOptions): Promise<SchemaPushResult>
}

/**
 * Forward-engineer databases/schemas/tables/collections from SchemaAst.
 * Consumes resolveEntityTenancy (hybrid resolves per entity). Does not migrate data.
 */
export async function pushSchema(
  ast: SchemaAst,
  target: SchemaPushTarget,
  options?: SchemaPushOptions,
): Promise<SchemaPushResult> {
  assertValidSchema(ast)
  const plan = buildPushPlan(ast, options)

  switch (target.dialect) {
    case 'postgres':
      return pushPostgresSchema(target.connectionString, plan)
    case 'mysql':
      return pushMysqlSchema(target.connectionString, plan)
    case 'mongodb':
      return pushMongodbSchema(target.connectionString, plan)
    default: {
      const _exhaustive: never = target.dialect
      throw new SchemaPushError(
        'UNSUPPORTED_DIALECT',
        `unsupported dialect: ${String(_exhaustive)}`,
      )
    }
  }
}

/**
 * Bind a push target once; push many schemas (e.g. CLI/db push later).
 */
export function createSchemaPusher(target: SchemaPushTarget): SchemaPusher {
  return {
    push(ast: SchemaAst, options?: SchemaPushOptions): Promise<SchemaPushResult> {
      return pushSchema(ast, target, options)
    },
  }
}
