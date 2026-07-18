import {
  type ConcreteTenancyModel,
  type SchemaTenancy,
  TENANT_ID_FIELD_NAME,
} from '../ast/tenancy.js'
import type {
  EntityDefinition,
  FieldDefinition,
  RelationDefinition,
  SchemaAst,
} from '../ast/types.js'
import { assertValidSchema, SchemaValidationError } from '../ast/validate.js'
import type { CatalogForeignKey, CatalogObject, CatalogSnapshot } from './catalog.js'
import { SchemaPullError } from './errors.js'
import { mapNativeTypeToScalar } from './map-types.js'
import type { InferredEntityTenancy, SchemaPullOptions } from './types.js'

function pickRepresentative(snapshot: CatalogSnapshot, entityName: string): CatalogObject {
  const matches = snapshot.objects.filter((object) => object.name === entityName)
  const preferred = matches.find((object) => object.namespaceKind === 'default') ?? matches[0]
  if (preferred === undefined) {
    throw new SchemaPullError('EXECUTION_FAILED', `no catalog object for entity ${entityName}`)
  }
  return preferred
}

function columnsToFields(
  object: CatalogObject,
  model: ConcreteTenancyModel | 'global',
  warnings: string[],
): FieldDefinition[] {
  const fields: FieldDefinition[] = []
  let hasPk = false

  for (const column of object.columns) {
    if (column.name === '_id' && object.kind === 'collection') {
      // Prefer application `id` when present; otherwise map _id → id.
      if (object.columns.some((c) => c.name === 'id')) {
        continue
      }
      fields.push({
        name: 'id',
        type: 'String',
        primaryKey: true,
      })
      hasPk = true
      continue
    }

    const mapped = mapNativeTypeToScalar(column.nativeType)
    const type = mapped ?? 'String'
    if (mapped === undefined) {
      warnings.push(
        `${object.name}.${column.name}: unmapped native type ${JSON.stringify(column.nativeType)}; using String`,
      )
    }

    const isTenantId = column.name === TENANT_ID_FIELD_NAME
    const field: FieldDefinition = {
      name: column.name,
      type,
      optional: column.nullable && column.isPrimaryKey !== true,
      primaryKey: column.isPrimaryKey === true,
      unique: column.isUnique === true && column.isPrimaryKey !== true ? true : undefined,
      isTenantId: isTenantId ? true : undefined,
    }

    // Global entities must not mark tenant_id; pool requires it.
    if (isTenantId && model === 'global') {
      delete field.isTenantId
      warnings.push(
        `${object.name}: tenant_id column present on global entity; not marking isTenantId`,
      )
    }

    if (field.primaryKey === true) {
      hasPk = true
    }

    fields.push(field)
  }

  if (!hasPk && fields.length > 0) {
    const first = fields[0]
    if (first !== undefined) {
      // Ensure AST invariant: at least one PK — promote first field.
      fields[0] = { ...first, primaryKey: true, optional: false }
      warnings.push(`${object.name}: no primary key detected; marking ${first.name} as @id`)
    }
  }

  if (fields.length === 0) {
    fields.push({ name: 'id', type: 'String', primaryKey: true })
    warnings.push(`${object.name}: empty column set; synthesized id String @id`)
  }

  return fields
}

function foreignKeysToRelations(
  fks: CatalogForeignKey[],
  entityName: string,
  knownEntities: Set<string>,
  warnings: string[],
): RelationDefinition[] {
  const relations: RelationDefinition[] = []
  for (const fk of fks) {
    if (!knownEntities.has(fk.referencedTable)) {
      warnings.push(
        `${entityName}: skipped FK ${fk.constraintName} → ${fk.referencedTable} (target not in pulled schema)`,
      )
      continue
    }
    const relName =
      fk.constraintName.replace(/_fkey$/i, '').replace(new RegExp(`^${entityName}_`, 'i'), '') ||
      fk.referencedTable.toLowerCase()
    relations.push({
      name: relName,
      kind: 'many-to-one',
      target: fk.referencedTable,
      fields: [...fk.columns],
      references: [...fk.referencedColumns],
    })
  }
  return relations
}

function buildSchemaTenancy(inferred: InferredEntityTenancy[]): {
  tenancy: SchemaTenancy
  entityModels: Map<string, ConcreteTenancyModel | 'global'>
} {
  const entityModels = new Map<string, ConcreteTenancyModel | 'global'>()
  for (const entry of inferred) {
    entityModels.set(entry.entity, entry.model)
  }

  const nonGlobal = inferred.filter((entry) => entry.model !== 'global')
  const distinct = new Set(nonGlobal.map((entry) => entry.model))

  if (nonGlobal.length === 0) {
    // All global — schema still needs a concrete model; use pool as neutral default.
    return {
      tenancy: { model: 'shared-db-shared-schema' },
      entityModels,
    }
  }

  if (distinct.size === 1) {
    const first = nonGlobal[0]
    if (first === undefined || first.model === 'global') {
      return {
        tenancy: { model: 'shared-db-shared-schema' },
        entityModels,
      }
    }
    return {
      tenancy: { model: first.model },
      entityModels,
    }
  }

  // Hybrid: mix of concrete models (and possibly globals).
  const bindings = nonGlobal.map((entry) => ({
    scope: 'entity' as const,
    name: entry.entity,
    model: entry.model as ConcreteTenancyModel,
  }))

  return {
    tenancy: {
      model: 'hybrid',
      bindings,
      defaultModel: 'shared-db-shared-schema',
    },
    entityModels,
  }
}

/**
 * Build a validated SchemaAst from catalog + inferred tenancy.
 */
export function buildAstFromCatalog(
  snapshot: CatalogSnapshot,
  inferred: InferredEntityTenancy[],
  options: SchemaPullOptions | undefined,
  warnings: string[],
): SchemaAst {
  const { tenancy, entityModels } = buildSchemaTenancy(inferred)
  const knownEntities = new Set(inferred.map((entry) => entry.entity))
  const entities: EntityDefinition[] = []

  for (const entry of inferred) {
    const object = pickRepresentative(snapshot, entry.entity)
    const model = entityModels.get(entry.entity) ?? entry.model
    const fields = columnsToFields(object, model, warnings)

    const entity: EntityDefinition = {
      name: entry.entity,
      fields,
    }

    if (model === 'global') {
      entity.global = true
    } else if (tenancy.model === 'hybrid') {
      entity.tenancyModel = model
    }

    if (object.kind === 'table' && object.foreignKeys.length > 0) {
      const relations = foreignKeysToRelations(
        object.foreignKeys,
        entry.entity,
        knownEntities,
        warnings,
      )
      if (relations.length > 0) {
        entity.relations = relations
      }
    } else if (object.kind === 'collection' && object.foreignKeys.length === 0) {
      // Mongo: no FKs — optional informational warning once per pull (caller may add).
    }

    entities.push(entity)
  }

  if (snapshot.dialect === 'mongodb') {
    warnings.push('MongoDB has no foreign-key constraints; relations were not inferred')
  }

  const ast: SchemaAst = {
    name: options?.schemaName ?? 'pulled',
    tenancy,
    entities,
  }

  try {
    assertValidSchema(ast)
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new SchemaPullError(
        'SCHEMA_VALIDATION',
        `pulled AST failed validation: ${error.message}`,
      )
    }
    throw error
  }

  return ast
}
