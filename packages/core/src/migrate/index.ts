export { TenancyMigrateError, type TenancyMigrateErrorCode } from './errors.js'
export { createTenancyMigrator, migrateTenancy, type TenancyMigrator } from './migrate.js'
export {
  assertConcreteOrGlobal,
  buildMigratePlan,
  isSupportedTransition,
} from './plan.js'
export type {
  EntityMigrateAction,
  EntityMigrateStep,
  TenancyMigrateDialect,
  TenancyMigratedRow,
  TenancyMigrateOptions,
  TenancyMigratePlan,
  TenancyMigrateResult,
  TenancyMigrateTarget,
} from './types.js'
