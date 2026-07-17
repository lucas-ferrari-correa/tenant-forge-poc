import { resolveEntityTenancy, TenancyResolutionError } from './resolve.js'
import {
  type ConcreteTenancyModel,
  requiresTenantIdColumn,
  TENANT_ID_FIELD_NAME,
  usesSchemaIsolation,
} from './tenancy.js'
import type {
  EntityDefinition,
  FieldDefinition,
  RelationDefinition,
  SchemaAst,
  ServiceDefinition,
} from './types.js'
import { isRelationKind, isScalarFieldType } from './types.js'

export type ValidationIssueCode =
  | 'EMPTY_SCHEMA_NAME'
  | 'DUPLICATE_ENTITY'
  | 'EMPTY_ENTITY_NAME'
  | 'ENTITY_WITHOUT_FIELDS'
  | 'DUPLICATE_FIELD'
  | 'EMPTY_FIELD_NAME'
  | 'INVALID_FIELD_TYPE'
  | 'MISSING_PRIMARY_KEY'
  | 'DUPLICATE_PRIMARY_KEY'
  | 'DUPLICATE_RELATION'
  | 'EMPTY_RELATION_NAME'
  | 'INVALID_RELATION_KIND'
  | 'UNKNOWN_RELATION_TARGET'
  | 'RELATION_FIELD_MISMATCH'
  | 'UNKNOWN_RELATION_FIELD'
  | 'UNKNOWN_RELATION_REFERENCE'
  | 'MISSING_TENANT_ID'
  | 'FORBIDDEN_TENANT_ID'
  | 'DUPLICATE_TENANT_ID_FIELD'
  | 'NON_HYBRID_ENTITY_OVERRIDE'
  | 'HYBRID_UNRESOLVABLE_ENTITY'
  | 'DUPLICATE_SERVICE'
  | 'EMPTY_SERVICE_NAME'
  | 'UNKNOWN_SERVICE_ENTITY'
  | 'DUPLICATE_HYBRID_BINDING'
  | 'EMPTY_HYBRID_BINDING_NAME'
  | 'INVALID_HYBRID_BINDING_ENTITY'
  | 'INVALID_HYBRID_BINDING_SERVICE'
  | 'GLOBAL_WITH_TENANT_ID_MARK'

export type ValidationIssue = {
  code: ValidationIssueCode
  message: string
  path?: string
}

export type ValidationResult =
  | { ok: true; issues: [] }
  | { ok: false; issues: [ValidationIssue, ...ValidationIssue[]] }

export class SchemaValidationError extends Error {
  readonly code = 'SCHEMA_VALIDATION' as const
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    const summary = issues.map((issue) => issue.message).join('; ')
    super(`invalid schema AST: ${summary}`)
    this.name = 'SchemaValidationError'
    this.issues = issues
  }
}

function pushIssue(issues: ValidationIssue[], issue: ValidationIssue): void {
  issues.push(issue)
}

function findTenantIdFields(fields: FieldDefinition[]): FieldDefinition[] {
  return fields.filter((field) => field.isTenantId === true || field.name === TENANT_ID_FIELD_NAME)
}

function validateFields(entity: EntityDefinition, issues: ValidationIssue[]): void {
  const pathPrefix = `entities.${entity.name}`

  if (entity.fields.length === 0) {
    pushIssue(issues, {
      code: 'ENTITY_WITHOUT_FIELDS',
      message: `entity "${entity.name}" must declare at least one field`,
      path: pathPrefix,
    })
    return
  }

  const seen = new Set<string>()
  let primaryKeyCount = 0

  for (const field of entity.fields) {
    const fieldPath = `${pathPrefix}.fields.${field.name || '?'}`

    if (field.name.trim().length === 0) {
      pushIssue(issues, {
        code: 'EMPTY_FIELD_NAME',
        message: `entity "${entity.name}" has a field with empty name`,
        path: `${pathPrefix}.fields`,
      })
      continue
    }

    if (seen.has(field.name)) {
      pushIssue(issues, {
        code: 'DUPLICATE_FIELD',
        message: `duplicate field "${field.name}" on entity "${entity.name}"`,
        path: fieldPath,
      })
    }
    seen.add(field.name)

    if (!isScalarFieldType(field.type)) {
      pushIssue(issues, {
        code: 'INVALID_FIELD_TYPE',
        message: `field "${entity.name}.${field.name}" has invalid type "${String(field.type)}"`,
        path: fieldPath,
      })
    }

    if (field.primaryKey === true) {
      primaryKeyCount += 1
    }
  }

  if (primaryKeyCount === 0) {
    pushIssue(issues, {
      code: 'MISSING_PRIMARY_KEY',
      message: `entity "${entity.name}" must have exactly one primary key field`,
      path: pathPrefix,
    })
  } else if (primaryKeyCount > 1) {
    pushIssue(issues, {
      code: 'DUPLICATE_PRIMARY_KEY',
      message: `entity "${entity.name}" has ${primaryKeyCount} primary key fields; expected 1`,
      path: pathPrefix,
    })
  }

  const tenantIdFields = findTenantIdFields(entity.fields)
  if (tenantIdFields.length > 1) {
    pushIssue(issues, {
      code: 'DUPLICATE_TENANT_ID_FIELD',
      message: `entity "${entity.name}" has multiple tenant_id markers`,
      path: pathPrefix,
    })
  }

  if (entity.global === true && tenantIdFields.length > 0) {
    pushIssue(issues, {
      code: 'GLOBAL_WITH_TENANT_ID_MARK',
      message: `global entity "${entity.name}" must not declare a tenant_id field`,
      path: pathPrefix,
    })
  }
}

function validateRelations(
  ast: SchemaAst,
  entity: EntityDefinition,
  entityNames: Set<string>,
  issues: ValidationIssue[],
): void {
  const relations = entity.relations ?? []
  const seen = new Set<string>()
  const fieldNames = new Set(entity.fields.map((field) => field.name))

  for (const relation of relations) {
    const pathPrefix = `entities.${entity.name}.relations.${relation.name || '?'}`

    if (relation.name.trim().length === 0) {
      pushIssue(issues, {
        code: 'EMPTY_RELATION_NAME',
        message: `entity "${entity.name}" has a relation with empty name`,
        path: `entities.${entity.name}.relations`,
      })
      continue
    }

    if (seen.has(relation.name)) {
      pushIssue(issues, {
        code: 'DUPLICATE_RELATION',
        message: `duplicate relation "${relation.name}" on entity "${entity.name}"`,
        path: pathPrefix,
      })
    }
    seen.add(relation.name)

    if (!isRelationKind(relation.kind)) {
      pushIssue(issues, {
        code: 'INVALID_RELATION_KIND',
        message: `relation "${entity.name}.${relation.name}" has invalid kind "${String(relation.kind)}"`,
        path: pathPrefix,
      })
    }

    if (!entityNames.has(relation.target)) {
      pushIssue(issues, {
        code: 'UNKNOWN_RELATION_TARGET',
        message: `relation "${entity.name}.${relation.name}" targets unknown entity "${relation.target}"`,
        path: pathPrefix,
      })
    }

    validateRelationSides(ast, entity, relation, fieldNames, entityNames, issues, pathPrefix)
  }
}

function validateRelationSides(
  ast: SchemaAst,
  entity: EntityDefinition,
  relation: RelationDefinition,
  fieldNames: Set<string>,
  entityNames: Set<string>,
  issues: ValidationIssue[],
  pathPrefix: string,
): void {
  const localFields = relation.fields ?? []
  const refs = relation.references ?? []

  if (localFields.length !== refs.length) {
    pushIssue(issues, {
      code: 'RELATION_FIELD_MISMATCH',
      message: `relation "${entity.name}.${relation.name}" fields/references length mismatch (${localFields.length} vs ${refs.length})`,
      path: pathPrefix,
    })
  }

  for (const local of localFields) {
    if (!fieldNames.has(local)) {
      pushIssue(issues, {
        code: 'UNKNOWN_RELATION_FIELD',
        message: `relation "${entity.name}.${relation.name}" references unknown local field "${local}"`,
        path: pathPrefix,
      })
    }
  }

  if (!entityNames.has(relation.target)) {
    return
  }

  const target = ast.entities.find((candidate) => candidate.name === relation.target)
  if (!target) {
    return
  }

  const targetFields = new Set(target.fields.map((field) => field.name))
  for (const ref of refs) {
    if (!targetFields.has(ref)) {
      pushIssue(issues, {
        code: 'UNKNOWN_RELATION_REFERENCE',
        message: `relation "${entity.name}.${relation.name}" references unknown field "${ref}" on "${relation.target}"`,
        path: pathPrefix,
      })
    }
  }
}

function validateTenantIdInvariant(
  entity: EntityDefinition,
  model: ConcreteTenancyModel,
  issues: ValidationIssue[],
): void {
  if (entity.global === true) {
    return
  }

  const pathPrefix = `entities.${entity.name}`
  const tenantIdFields = findTenantIdFields(entity.fields)

  if (requiresTenantIdColumn(model)) {
    if (tenantIdFields.length === 0) {
      pushIssue(issues, {
        code: 'MISSING_TENANT_ID',
        message: `entity "${entity.name}" under shared-db-shared-schema (pool) must declare a tenant_id field`,
        path: pathPrefix,
      })
    }
  }

  if (usesSchemaIsolation(model) && tenantIdFields.some((field) => field.isTenantId === true)) {
    pushIssue(issues, {
      code: 'FORBIDDEN_TENANT_ID',
      message: `entity "${entity.name}" under shared-db-isolated-schema (bridge) must not mark isTenantId (isolation is by schema)`,
      path: pathPrefix,
    })
  }
}

function validateServices(
  ast: SchemaAst,
  entityNames: Set<string>,
  issues: ValidationIssue[],
): void {
  const services = ast.services ?? []
  const seen = new Set<string>()

  for (const service of services) {
    if (service.name.trim().length === 0) {
      pushIssue(issues, {
        code: 'EMPTY_SERVICE_NAME',
        message: 'service name must be non-empty',
        path: 'services',
      })
      continue
    }

    if (seen.has(service.name)) {
      pushIssue(issues, {
        code: 'DUPLICATE_SERVICE',
        message: `duplicate service "${service.name}"`,
        path: `services.${service.name}`,
      })
    }
    seen.add(service.name)

    for (const entityName of service.entities ?? []) {
      if (!entityNames.has(entityName)) {
        pushIssue(issues, {
          code: 'UNKNOWN_SERVICE_ENTITY',
          message: `service "${service.name}" references unknown entity "${entityName}"`,
          path: `services.${service.name}`,
        })
      }
    }

    if (ast.tenancy.model !== 'hybrid' && service.tenancyModel !== ast.tenancy.model) {
      pushIssue(issues, {
        code: 'NON_HYBRID_ENTITY_OVERRIDE',
        message: `service "${service.name}" declares tenancy "${service.tenancyModel}" but schema is non-hybrid "${ast.tenancy.model}"`,
        path: `services.${service.name}`,
      })
    }
  }
}

function validateHybridBindings(
  ast: SchemaAst,
  entityNames: Set<string>,
  services: ServiceDefinition[],
  issues: ValidationIssue[],
): void {
  if (ast.tenancy.model !== 'hybrid') {
    return
  }

  const serviceNames = new Set(services.map((service) => service.name))
  const seenKeys = new Set<string>()

  for (const binding of ast.tenancy.bindings) {
    if (binding.name.trim().length === 0) {
      pushIssue(issues, {
        code: 'EMPTY_HYBRID_BINDING_NAME',
        message: `hybrid binding with scope "${binding.scope}" has empty name`,
        path: 'tenancy.bindings',
      })
      continue
    }

    const key = `${binding.scope}:${binding.name}`
    if (seenKeys.has(key)) {
      pushIssue(issues, {
        code: 'DUPLICATE_HYBRID_BINDING',
        message: `duplicate hybrid binding ${key}`,
        path: 'tenancy.bindings',
      })
    }
    seenKeys.add(key)

    if (binding.scope === 'entity' && !entityNames.has(binding.name)) {
      pushIssue(issues, {
        code: 'INVALID_HYBRID_BINDING_ENTITY',
        message: `hybrid entity binding references unknown entity "${binding.name}"`,
        path: 'tenancy.bindings',
      })
    }

    if (binding.scope === 'service' && !serviceNames.has(binding.name)) {
      pushIssue(issues, {
        code: 'INVALID_HYBRID_BINDING_SERVICE',
        message: `hybrid service binding references unknown service "${binding.name}"`,
        path: 'tenancy.bindings',
      })
    }
  }
}

function validateEntityTenancyOverrides(ast: SchemaAst, issues: ValidationIssue[]): void {
  for (const entity of ast.entities) {
    if (entity.tenancyModel === undefined) {
      continue
    }

    if (ast.tenancy.model !== 'hybrid' && entity.tenancyModel !== ast.tenancy.model) {
      pushIssue(issues, {
        code: 'NON_HYBRID_ENTITY_OVERRIDE',
        message: `entity "${entity.name}" overrides tenancy to "${entity.tenancyModel}" but schema is non-hybrid "${ast.tenancy.model}"`,
        path: `entities.${entity.name}`,
      })
    }
  }
}

function validateResolvableTenancy(ast: SchemaAst, issues: ValidationIssue[]): void {
  for (const entity of ast.entities) {
    try {
      const model = resolveEntityTenancy(ast, entity.name)
      validateTenantIdInvariant(entity, model, issues)
    } catch (error) {
      if (error instanceof TenancyResolutionError) {
        pushIssue(issues, {
          code: 'HYBRID_UNRESOLVABLE_ENTITY',
          message: error.message,
          path: `entities.${entity.name}`,
        })
      } else {
        throw error
      }
    }
  }
}

/**
 * Validates schema AST invariants (structure + tenancy taxonomy rules).
 * Pure function — does not mutate the AST.
 */
export function validateSchema(ast: SchemaAst): ValidationResult {
  const issues: ValidationIssue[] = []

  if (ast.name.trim().length === 0) {
    pushIssue(issues, {
      code: 'EMPTY_SCHEMA_NAME',
      message: 'schema name must be non-empty',
      path: 'name',
    })
  }

  const entityNames = new Set<string>()
  for (const entity of ast.entities) {
    if (entity.name.trim().length === 0) {
      pushIssue(issues, {
        code: 'EMPTY_ENTITY_NAME',
        message: 'entity name must be non-empty',
        path: 'entities',
      })
      continue
    }

    if (entityNames.has(entity.name)) {
      pushIssue(issues, {
        code: 'DUPLICATE_ENTITY',
        message: `duplicate entity "${entity.name}"`,
        path: `entities.${entity.name}`,
      })
    }
    entityNames.add(entity.name)
  }

  for (const entity of ast.entities) {
    if (entity.name.trim().length === 0) {
      continue
    }
    validateFields(entity, issues)
    validateRelations(ast, entity, entityNames, issues)
  }

  validateEntityTenancyOverrides(ast, issues)
  validateServices(ast, entityNames, issues)
  validateHybridBindings(ast, entityNames, ast.services ?? [], issues)
  validateResolvableTenancy(ast, issues)

  if (issues.length === 0) {
    return { ok: true, issues: [] }
  }

  return {
    ok: false,
    issues: issues as [ValidationIssue, ...ValidationIssue[]],
  }
}

/** Throws SchemaValidationError when the AST violates invariants. */
export function assertValidSchema(ast: SchemaAst): void {
  const result = validateSchema(ast)
  if (!result.ok) {
    throw new SchemaValidationError(result.issues)
  }
}

/**
 * Validates then returns the AST. Runtime-freezes nested objects in place
 * without widening arrays to `readonly` in the public type.
 */
export function defineSchema(ast: SchemaAst): SchemaAst {
  assertValidSchema(ast)
  freezeValue(ast)
  return ast
}

function freezeValue(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return
  }
  if (Object.isFrozen(value)) {
    return
  }
  Object.freeze(value)
  for (const nested of Object.values(value)) {
    freezeValue(nested)
  }
}
