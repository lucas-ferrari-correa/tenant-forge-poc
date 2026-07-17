import type { ConcreteTenancyModel, SchemaTenancy } from './tenancy.js'

/** Scalar types aligned with a Prisma-like surface (DSL arrives in Phase 3). */
export const SCALAR_FIELD_TYPES = [
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
  'Uuid',
] as const

export type ScalarFieldType = (typeof SCALAR_FIELD_TYPES)[number]

export type FieldDefault =
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'now' }
  | { kind: 'uuid' }
  | { kind: 'autoincrement' }

export type FieldDefinition = {
  name: string
  type: ScalarFieldType
  optional?: boolean
  unique?: boolean
  primaryKey?: boolean
  list?: boolean
  default?: FieldDefault
  /**
   * Marks the tenant isolation column for shared-schema (pool).
   * Prefer this over relying on the conventional name alone.
   */
  isTenantId?: boolean
}

export const RELATION_KINDS = ['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'] as const

export type RelationKind = (typeof RELATION_KINDS)[number]

export type RelationDefinition = {
  name: string
  kind: RelationKind
  /** Target entity name. */
  target: string
  /** Local FK field names (side that holds the foreign key). */
  fields?: string[]
  /** Referenced field names on the target entity. */
  references?: string[]
  optional?: boolean
}

export type EntityDefinition = {
  name: string
  fields: FieldDefinition[]
  relations?: RelationDefinition[]
  /**
   * Per-entity concrete model when schema tenancy is `hybrid`.
   * Must not be set (or must match schema) for non-hybrid schemas.
   */
  tenancyModel?: ConcreteTenancyModel
  /**
   * Global / reference entity (e.g. `tenants`, geo lookup tables).
   * Exempt from `tenant_id` requirement under shared-schema.
   */
  global?: boolean
}

export type ServiceDefinition = {
  name: string
  tenancyModel: ConcreteTenancyModel
  /** Entity names owned by this service (hybrid routing). */
  entities?: string[]
}

/**
 * In-memory schema AST — single source of truth for DSL and UI projections.
 */
export type SchemaAst = {
  name: string
  tenancy: SchemaTenancy
  entities: EntityDefinition[]
  services?: ServiceDefinition[]
}

export function isScalarFieldType(value: string): value is ScalarFieldType {
  return (SCALAR_FIELD_TYPES as readonly string[]).includes(value)
}

export function isRelationKind(value: string): value is RelationKind {
  return (RELATION_KINDS as readonly string[]).includes(value)
}
