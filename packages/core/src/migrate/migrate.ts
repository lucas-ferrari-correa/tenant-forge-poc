import type { SchemaAst } from '../ast/types.js'
import { assertValidSchema } from '../ast/validate.js'
import { SchemaPullError } from '../pull/errors.js'
import { pullSchema } from '../pull/pull.js'
import { pushSchema } from '../push/push.js'
import { TenancyMigrateError } from './errors.js'
import { migrateMongodbTenancy } from './mongodb.js'
import { migrateMysqlTenancy } from './mysql.js'
import { buildMigratePlan } from './plan.js'
import { migratePostgresTenancy } from './postgres.js'
import type { TenancyMigrateOptions, TenancyMigrateResult, TenancyMigrateTarget } from './types.js'

export type TenancyMigrator = {
  migrate(ast: SchemaAst, options: TenancyMigrateOptions): Promise<TenancyMigrateResult>
}

async function resolveSourceAst(
  target: TenancyMigrateTarget,
  options: TenancyMigrateOptions,
): Promise<{ sourceAst: SchemaAst; warnings: string[] }> {
  if (options.from !== undefined) {
    assertValidSchema(options.from)
    return { sourceAst: options.from, warnings: [] }
  }

  try {
    const pulled = await pullSchema(
      { dialect: target.dialect, connectionString: target.connectionString },
      options.pull,
    )
    return { sourceAst: pulled.ast, warnings: [...pulled.warnings] }
  } catch (error) {
    if (error instanceof SchemaPullError) {
      if (error.code === 'AMBIGUOUS_TENANCY') {
        throw new TenancyMigrateError(
          'AMBIGUOUS_SOURCE',
          `cannot infer source tenancy: ${error.message}`,
        )
      }
      throw new TenancyMigrateError('EXECUTION_FAILED', `pull failed: ${error.message}`)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new TenancyMigrateError('EXECUTION_FAILED', `pull failed: ${message}`)
  }
}

/**
 * Migrate tenancy architecture of an existing (or freshly provisioned) database
 * toward `ast`, with real data movement. Best-effort POC — see module warnings.
 */
export async function migrateTenancy(
  ast: SchemaAst,
  target: TenancyMigrateTarget,
  options: TenancyMigrateOptions,
): Promise<TenancyMigrateResult> {
  try {
    assertValidSchema(ast)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new TenancyMigrateError('SCHEMA_VALIDATION', message)
  }

  if (options.tenants === undefined || options.tenants.length === 0) {
    throw new TenancyMigrateError(
      'TENANTS_REQUIRED',
      'options.tenants is required (non-empty) for tenancy migration',
    )
  }

  const { sourceAst, warnings: sourceWarnings } = await resolveSourceAst(target, options)
  const plan = buildMigratePlan(sourceAst, ast, options)

  // Provision destination layout (idempotent IF NOT EXISTS).
  const pushResult = await pushSchema(ast, target, {
    tenants: options.tenants,
    rlsSessionVar: options.rlsSessionVar,
  })

  const warnings = [...sourceWarnings, ...pushResult.warnings]

  const executed = await (async () => {
    switch (target.dialect) {
      case 'postgres':
        return migratePostgresTenancy(target.connectionString, plan)
      case 'mysql':
        return migrateMysqlTenancy(target.connectionString, plan)
      case 'mongodb':
        return migrateMongodbTenancy(target.connectionString, plan)
      default: {
        const _exhaustive: never = target.dialect
        throw new TenancyMigrateError(
          'UNSUPPORTED_DIALECT',
          `unsupported dialect: ${String(_exhaustive)}`,
        )
      }
    }
  })()

  return {
    dialect: target.dialect,
    steps: plan.steps,
    migrated: executed.migrated,
    warnings: [...warnings, ...executed.warnings],
  }
}

/**
 * Bind a migrate target once; migrate many schemas (e.g. CLI `tenancy migrate` later).
 */
export function createTenancyMigrator(target: TenancyMigrateTarget): TenancyMigrator {
  return {
    migrate(ast: SchemaAst, options: TenancyMigrateOptions): Promise<TenancyMigrateResult> {
      return migrateTenancy(ast, target, options)
    },
  }
}
