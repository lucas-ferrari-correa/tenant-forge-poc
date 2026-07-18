import type { SchemaTenancy } from '../ast/tenancy.js'
import type {
  EntityDefinition,
  FieldDefault,
  FieldDefinition,
  RelationDefinition,
  ServiceDefinition,
} from '../ast/types.js'
import type { SchemaDiffChange } from './types.js'

/** Normalize optional boolean flags so `undefined` and `false` compare equal. */
export function boolFlag(value: boolean | undefined): boolean {
  return value === true
}

export function fieldDefaultsEqual(
  local: FieldDefault | undefined,
  remote: FieldDefault | undefined,
): boolean {
  // Best-effort: only compare when both sides declare a default (pull rarely has them).
  if (local === undefined || remote === undefined) {
    return true
  }
  if (local.kind !== remote.kind) {
    return false
  }
  if (local.kind === 'literal' && remote.kind === 'literal') {
    return local.value === remote.value
  }
  return true
}

export function stringArraysEqual(
  local: readonly string[] | undefined,
  remote: readonly string[] | undefined,
): boolean {
  const left = local ?? []
  const right = remote ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((value, index) => value === right[index])
}

export function indexByName<T extends { name: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const item of items) {
    map.set(item.name, item)
  }
  return map
}

export function pushChange(changes: SchemaDiffChange[], change: SchemaDiffChange): void {
  changes.push(change)
}

export function snapshotField(field: FieldDefinition): Record<string, unknown> {
  return {
    name: field.name,
    type: field.type,
    optional: boolFlag(field.optional),
    unique: boolFlag(field.unique),
    primaryKey: boolFlag(field.primaryKey),
    list: boolFlag(field.list),
    isTenantId: boolFlag(field.isTenantId),
    ...(field.default !== undefined ? { default: field.default } : {}),
  }
}

export function snapshotRelation(relation: RelationDefinition): Record<string, unknown> {
  return {
    name: relation.name,
    kind: relation.kind,
    target: relation.target,
    fields: relation.fields ?? [],
    references: relation.references ?? [],
    optional: boolFlag(relation.optional),
  }
}

export function snapshotEntityMeta(entity: EntityDefinition): Record<string, unknown> {
  return {
    name: entity.name,
    global: boolFlag(entity.global),
    tenancyModel: entity.tenancyModel ?? null,
  }
}

export function snapshotService(service: ServiceDefinition): Record<string, unknown> {
  return {
    name: service.name,
    tenancyModel: service.tenancyModel,
    entities: [...(service.entities ?? [])].sort(),
  }
}

export function snapshotSchemaTenancy(tenancy: SchemaTenancy): Record<string, unknown> {
  if (tenancy.model === 'hybrid') {
    return {
      model: tenancy.model,
      defaultModel: tenancy.defaultModel ?? null,
      // Bindings are authoring sugar — effective tenancy is compared per entity.
    }
  }
  return { model: tenancy.model }
}

export function fieldsEqual(local: FieldDefinition, remote: FieldDefinition): boolean {
  return (
    local.type === remote.type &&
    boolFlag(local.optional) === boolFlag(remote.optional) &&
    boolFlag(local.unique) === boolFlag(remote.unique) &&
    boolFlag(local.primaryKey) === boolFlag(remote.primaryKey) &&
    boolFlag(local.list) === boolFlag(remote.list) &&
    boolFlag(local.isTenantId) === boolFlag(remote.isTenantId) &&
    fieldDefaultsEqual(local.default, remote.default)
  )
}

export function relationsEqual(local: RelationDefinition, remote: RelationDefinition): boolean {
  return (
    local.kind === remote.kind &&
    local.target === remote.target &&
    boolFlag(local.optional) === boolFlag(remote.optional) &&
    stringArraysEqual(local.fields, remote.fields) &&
    stringArraysEqual(local.references, remote.references)
  )
}

export function entityMetaEqual(local: EntityDefinition, remote: EntityDefinition): boolean {
  return (
    boolFlag(local.global) === boolFlag(remote.global) &&
    (local.tenancyModel ?? undefined) === (remote.tenancyModel ?? undefined)
  )
}

export function servicesEqual(local: ServiceDefinition, remote: ServiceDefinition): boolean {
  if (local.tenancyModel !== remote.tenancyModel) {
    return false
  }
  const left = [...(local.entities ?? [])].sort()
  const right = [...(remote.entities ?? [])].sort()
  return stringArraysEqual(left, right)
}

export function schemaTenancyEqual(local: SchemaTenancy, remote: SchemaTenancy): boolean {
  if (local.model !== remote.model) {
    return false
  }
  if (local.model === 'hybrid' && remote.model === 'hybrid') {
    return (local.defaultModel ?? undefined) === (remote.defaultModel ?? undefined)
  }
  return true
}
