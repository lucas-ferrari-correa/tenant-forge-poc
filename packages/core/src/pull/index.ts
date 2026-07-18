export { buildAstFromCatalog } from './build-ast.js'
export {
  type CatalogColumn,
  type CatalogForeignKey,
  type CatalogNamespaceKind,
  type CatalogObject,
  type CatalogSnapshot,
  DEFAULT_SILO_NAMESPACE_PATTERN,
  DEFAULT_TENANT_NAMESPACE_PATTERN,
  hasTenantIdColumn,
  isTenantNamespace,
} from './catalog.js'
export { SchemaPullError, type SchemaPullErrorCode } from './errors.js'
export {
  buildEntitySignalsFromObjects,
  classifyEntityTenancy,
  type EntityLayoutSignals,
  type InferTenancyResult,
  inferTenancyFromCatalog,
} from './infer.js'
export { createSchemaPuller, pullSchema, type SchemaPuller } from './pull.js'
export type {
  InferredEntityTenancy,
  SchemaPullDialect,
  SchemaPullOptions,
  SchemaPullResult,
  SchemaPullTarget,
} from './types.js'
