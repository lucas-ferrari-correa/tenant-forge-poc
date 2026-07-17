export {
  assertConcreteTenancyModel,
  listConcreteModelsInSchema,
  resolveEntityTenancy,
  resolveServiceTenancy,
  TenancyResolutionError,
} from './resolve.js'

export {
  CONCRETE_TENANCY_MODELS,
  type ConcreteTenancyModel,
  type HybridBinding,
  type HybridBindingScope,
  isConcreteTenancyModel,
  isTenancyModel,
  requiresTenantIdColumn,
  type SchemaTenancy,
  TENANCY_MARKET_ALIAS,
  TENANCY_MODELS,
  TENANT_ID_FIELD_NAME,
  type TenancyMarketAlias,
  type TenancyModel,
  usesPhysicalIsolation,
  usesSchemaIsolation,
} from './tenancy.js'

export {
  assertNoUntrustedTenantAuthority,
  type CreateTenantContextInput,
  createTenantContext,
  InvalidTenantContextError,
  isTrustedTenantSource,
  type TenantContext,
  TRUSTED_TENANT_SOURCES,
  type TrustedTenantSource,
  tenantContextFromJwtClaim,
  UntrustedTenantAuthorityError,
  type UntrustedTenantInput,
} from './tenant-context.js'

export {
  type EntityDefinition,
  type FieldDefault,
  type FieldDefinition,
  isRelationKind,
  isScalarFieldType,
  RELATION_KINDS,
  type RelationDefinition,
  type RelationKind,
  SCALAR_FIELD_TYPES,
  type ScalarFieldType,
  type SchemaAst,
  type ServiceDefinition,
} from './types.js'

export {
  assertValidSchema,
  defineSchema,
  SchemaValidationError,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationResult,
  validateSchema,
} from './validate.js'
