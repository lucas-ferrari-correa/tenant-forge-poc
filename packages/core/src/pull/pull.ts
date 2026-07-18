import { buildAstFromCatalog } from './build-ast.js'
import { SchemaPullError } from './errors.js'
import { inferTenancyFromCatalog } from './infer.js'
import { introspectMongodbCatalog } from './mongodb.js'
import { introspectMysqlCatalog } from './mysql.js'
import { introspectPostgresCatalog } from './postgres.js'
import type { SchemaPullOptions, SchemaPullResult, SchemaPullTarget } from './types.js'

export type SchemaPuller = {
  pull(options?: SchemaPullOptions): Promise<SchemaPullResult>
}

/**
 * Introspect an existing database into SchemaAst, inferring tenancy layout.
 * Fail-closed with AMBIGUOUS_TENANCY when heuristic is non-deterministic without hints.
 */
export async function pullSchema(
  target: SchemaPullTarget,
  options?: SchemaPullOptions,
): Promise<SchemaPullResult> {
  const snapshot = await (async () => {
    switch (target.dialect) {
      case 'postgres':
        return introspectPostgresCatalog(target.connectionString, options)
      case 'mysql':
        return introspectMysqlCatalog(target.connectionString, options)
      case 'mongodb':
        return introspectMongodbCatalog(target.connectionString, options)
      default: {
        const _exhaustive: never = target.dialect
        throw new SchemaPullError(
          'UNSUPPORTED_DIALECT',
          `unsupported dialect: ${String(_exhaustive)}`,
        )
      }
    }
  })()

  const { inferred, warnings: inferWarnings } = inferTenancyFromCatalog(snapshot, options)
  const warnings = [...inferWarnings]
  const ast = buildAstFromCatalog(snapshot, inferred, options, warnings)

  return {
    dialect: target.dialect,
    ast,
    inferred,
    warnings,
  }
}

/**
 * Bind a pull target once; pull repeatedly (e.g. CLI db pull later).
 */
export function createSchemaPuller(target: SchemaPullTarget): SchemaPuller {
  return {
    pull(options?: SchemaPullOptions): Promise<SchemaPullResult> {
      return pullSchema(target, options)
    },
  }
}
