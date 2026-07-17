import type { HybridBinding, SchemaTenancy } from '../ast/tenancy.js'
import type {
  EntityDefinition,
  FieldDefault,
  FieldDefinition,
  RelationDefinition,
  SchemaAst,
  ServiceDefinition,
} from '../ast/types.js'

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function serializeDefault(value: FieldDefault): string {
  switch (value.kind) {
    case 'now':
      return 'now()'
    case 'uuid':
      return 'uuid()'
    case 'autoincrement':
      return 'autoincrement()'
    case 'literal':
      if (typeof value.value === 'string') {
        return quote(value.value)
      }
      if (typeof value.value === 'boolean') {
        return value.value ? 'true' : 'false'
      }
      return String(value.value)
  }
}

function serializeField(field: FieldDefinition): string {
  let typeText: string = field.type
  if (field.list === true) {
    typeText = `${typeText}[]`
  } else if (field.optional === true) {
    typeText = `${typeText}?`
  }

  const attrs: string[] = []
  if (field.primaryKey === true) {
    attrs.push('@id')
  }
  if (field.unique === true) {
    attrs.push('@unique')
  }
  if (field.isTenantId === true) {
    attrs.push('@tenantId')
  }
  if (field.default !== undefined) {
    attrs.push(`@default(${serializeDefault(field.default)})`)
  }

  const attrSuffix = attrs.length > 0 ? ` ${attrs.join(' ')}` : ''
  return `  ${field.name} ${typeText}${attrSuffix}`
}

function serializeRelation(relation: RelationDefinition): string {
  let type = relation.target
  if (relation.optional === true) {
    type = `${type}?`
  }

  const args: string[] = [`kind = ${quote(relation.kind)}`]
  if (relation.fields !== undefined && relation.fields.length > 0) {
    args.push(`fields = [${relation.fields.join(', ')}]`)
  }
  if (relation.references !== undefined && relation.references.length > 0) {
    args.push(`references = [${relation.references.join(', ')}]`)
  }

  return `  ${relation.name} ${type} @relation(${args.join(', ')})`
}

function serializeEntity(entity: EntityDefinition): string {
  const lines: string[] = [`model ${entity.name} {`]
  for (const field of entity.fields) {
    lines.push(serializeField(field))
  }
  for (const relation of entity.relations ?? []) {
    lines.push(serializeRelation(relation))
  }
  if (entity.global === true) {
    lines.push('  @@global')
  }
  if (entity.tenancyModel !== undefined) {
    lines.push(`  @@tenancy(${quote(entity.tenancyModel)})`)
  }
  lines.push('}')
  return lines.join('\n')
}

function serializeBinding(binding: HybridBinding): string {
  return `    binding ${binding.scope} ${binding.name} = ${quote(binding.model)}`
}

function serializeTenancy(tenancy: SchemaTenancy): string {
  const lines: string[] = ['  tenancy {', `    model = ${quote(tenancy.model)}`]
  if (tenancy.model === 'hybrid') {
    if (tenancy.defaultModel !== undefined) {
      lines.push(`    defaultModel = ${quote(tenancy.defaultModel)}`)
    }
    for (const binding of tenancy.bindings) {
      lines.push(serializeBinding(binding))
    }
  }
  lines.push('  }')
  return lines.join('\n')
}

function serializeService(service: ServiceDefinition): string {
  const lines: string[] = [
    `service ${service.name} {`,
    `  tenancy = ${quote(service.tenancyModel)}`,
  ]
  if (service.entities !== undefined) {
    lines.push(`  entities = [${service.entities.join(', ')}]`)
  }
  lines.push('}')
  return lines.join('\n')
}

/**
 * Serialize a SchemaAst to the canonical tenant-forge DSL form.
 * Stable whitespace and attribute order for round-trip idempotence.
 */
export function serializeSchema(ast: SchemaAst): string {
  const parts: string[] = [`schema ${ast.name} {`, serializeTenancy(ast.tenancy), '}']

  for (const entity of ast.entities) {
    parts.push('')
    parts.push(serializeEntity(entity))
  }

  for (const service of ast.services ?? []) {
    parts.push('')
    parts.push(serializeService(service))
  }

  return `${parts.join('\n')}\n`
}
