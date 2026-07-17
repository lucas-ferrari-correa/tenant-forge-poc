import {
  type ConcreteTenancyModel,
  type HybridBinding,
  type HybridBindingScope,
  isConcreteTenancyModel,
  isTenancyModel,
  type SchemaTenancy,
  type TenancyModel,
} from '../ast/tenancy.js'
import {
  type EntityDefinition,
  type FieldDefault,
  type FieldDefinition,
  isRelationKind,
  isScalarFieldType,
  type RelationDefinition,
  type RelationKind,
  type SchemaAst,
  type ServiceDefinition,
} from '../ast/types.js'
import { assertValidSchema } from '../ast/validate.js'
import { DslParseError, type DslSourcePosition } from './errors.js'
import { createLexer, type Lexer, type Token } from './lexer.js'

export type ParseSchemaOptions = {
  /** When true (default), run assertValidSchema after a successful parse. */
  validate?: boolean
}

type ParsedFieldOrRelation =
  | { kind: 'field'; field: FieldDefinition }
  | { kind: 'relation'; relation: RelationDefinition }

function expect(lexer: Lexer, kind: Token['kind'], label?: string): Token {
  const token = lexer.next()
  if (token.kind !== kind) {
    throw new DslParseError(
      token.kind === 'eof' ? 'UNEXPECTED_EOF' : 'UNEXPECTED_TOKEN',
      `expected ${label ?? kind}, got ${token.kind}${token.value ? ` ("${token.value}")` : ''}`,
      token.position,
    )
  }
  return token
}

function expectIdent(lexer: Lexer, label = 'identifier'): string {
  return expect(lexer, 'ident', label).value
}

function peekIs(lexer: Lexer, kind: Token['kind'], value?: string): boolean {
  const token = lexer.peek()
  if (token.kind !== kind) {
    return false
  }
  if (value !== undefined && token.value !== value) {
    return false
  }
  return true
}

function parseStringOrIdent(lexer: Lexer): { value: string; position: DslSourcePosition } {
  const token = lexer.peek()
  if (token.kind === 'string') {
    lexer.next()
    return { value: token.value, position: token.position }
  }
  if (token.kind === 'ident') {
    lexer.next()
    return { value: token.value, position: token.position }
  }
  throw new DslParseError(
    'UNEXPECTED_TOKEN',
    `expected string or identifier, got ${token.kind}`,
    token.position,
  )
}

function parseTenancyModel(lexer: Lexer): TenancyModel {
  const { value, position } = parseStringOrIdent(lexer)
  if (!isTenancyModel(value)) {
    throw new DslParseError('INVALID_TENANCY_MODEL', `unknown tenancy model "${value}"`, position)
  }
  return value
}

function parseConcreteTenancyModel(lexer: Lexer): ConcreteTenancyModel {
  const { value, position } = parseStringOrIdent(lexer)
  if (!isConcreteTenancyModel(value)) {
    throw new DslParseError(
      'INVALID_TENANCY_MODEL',
      `expected concrete tenancy model, got "${value}"`,
      position,
    )
  }
  return value
}

function parseIdentList(lexer: Lexer): string[] {
  expect(lexer, 'lbrack', '[')
  const names: string[] = []
  if (!peekIs(lexer, 'rbrack')) {
    names.push(expectIdent(lexer))
    while (peekIs(lexer, 'comma')) {
      lexer.next()
      names.push(expectIdent(lexer))
    }
  }
  expect(lexer, 'rbrack', ']')
  return names
}

function parseTenancyBlock(lexer: Lexer): SchemaTenancy {
  expect(lexer, 'lbrace', '{')

  let model: TenancyModel | undefined
  let defaultModel: ConcreteTenancyModel | undefined
  const bindings: HybridBinding[] = []

  while (!peekIs(lexer, 'rbrace') && !peekIs(lexer, 'eof')) {
    const key = expectIdent(lexer)

    if (key === 'model') {
      expect(lexer, 'eq', '=')
      model = parseTenancyModel(lexer)
      continue
    }

    if (key === 'defaultModel') {
      expect(lexer, 'eq', '=')
      defaultModel = parseConcreteTenancyModel(lexer)
      continue
    }

    if (key === 'binding') {
      const scopeToken = expectIdent(lexer, 'binding scope')
      if (scopeToken !== 'entity' && scopeToken !== 'service' && scopeToken !== 'tier') {
        throw new DslParseError(
          'INVALID_BINDING_SCOPE',
          `binding scope must be entity|service|tier, got "${scopeToken}"`,
          lexer.peek().position,
        )
      }
      const scope: HybridBindingScope = scopeToken
      const name = expectIdent(lexer, 'binding name')
      expect(lexer, 'eq', '=')
      const bindingModel = parseConcreteTenancyModel(lexer)
      bindings.push({ scope, name, model: bindingModel })
      continue
    }

    throw new DslParseError(
      'INVALID_BLOCK',
      `unknown tenancy property "${key}"`,
      lexer.peek().position,
    )
  }

  expect(lexer, 'rbrace', '}')

  if (model === undefined) {
    throw new DslParseError('MISSING_TENANCY', 'tenancy block requires model = ...')
  }

  if (model === 'hybrid') {
    return {
      model: 'hybrid',
      bindings,
      ...(defaultModel !== undefined ? { defaultModel } : {}),
    }
  }

  if (bindings.length > 0 || defaultModel !== undefined) {
    throw new DslParseError(
      'INVALID_BLOCK',
      `bindings/defaultModel are only valid when tenancy model is hybrid`,
    )
  }

  return { model }
}

function parseDefaultValue(lexer: Lexer): FieldDefault {
  const token = lexer.peek()

  if (token.kind === 'true' || token.kind === 'false') {
    lexer.next()
    return { kind: 'literal', value: token.kind === 'true' }
  }

  if (token.kind === 'number') {
    lexer.next()
    const numeric = Number(token.value)
    if (Number.isNaN(numeric)) {
      throw new DslParseError(
        'INVALID_DEFAULT',
        `invalid number default "${token.value}"`,
        token.position,
      )
    }
    return { kind: 'literal', value: numeric }
  }

  if (token.kind === 'string') {
    lexer.next()
    return { kind: 'literal', value: token.value }
  }

  if (token.kind === 'ident') {
    lexer.next()
    if (token.value === 'now' || token.value === 'uuid' || token.value === 'autoincrement') {
      if (peekIs(lexer, 'lparen')) {
        lexer.next()
        expect(lexer, 'rparen', ')')
      }
      return { kind: token.value }
    }
    throw new DslParseError(
      'INVALID_DEFAULT',
      `unknown default function "${token.value}"`,
      token.position,
    )
  }

  throw new DslParseError(
    'INVALID_DEFAULT',
    `unexpected default value (${token.kind})`,
    token.position,
  )
}

function parseRelationArgs(lexer: Lexer): {
  kind: RelationKind
  fields?: string[]
  references?: string[]
} {
  expect(lexer, 'lparen', '(')
  let kind: RelationKind | undefined
  let fields: string[] | undefined
  let references: string[] | undefined

  while (!peekIs(lexer, 'rparen') && !peekIs(lexer, 'eof')) {
    const key = expectIdent(lexer)
    expect(lexer, 'eq', '=')
    if (key === 'kind') {
      const { value, position } = parseStringOrIdent(lexer)
      if (!isRelationKind(value)) {
        throw new DslParseError(
          'INVALID_RELATION_KIND',
          `invalid relation kind "${value}"`,
          position,
        )
      }
      kind = value
    } else if (key === 'fields') {
      fields = parseIdentList(lexer)
    } else if (key === 'references') {
      references = parseIdentList(lexer)
    } else {
      throw new DslParseError(
        'UNEXPECTED_TOKEN',
        `unknown @relation argument "${key}"`,
        lexer.peek().position,
      )
    }
    if (peekIs(lexer, 'comma')) {
      lexer.next()
    }
  }

  expect(lexer, 'rparen', ')')

  if (kind === undefined) {
    throw new DslParseError('INVALID_RELATION_KIND', '@relation requires kind = ...')
  }

  return {
    kind,
    ...(fields !== undefined ? { fields } : {}),
    ...(references !== undefined ? { references } : {}),
  }
}

function parseFieldAttributes(
  lexer: Lexer,
  isRelation: boolean,
): {
  optional?: boolean
  unique?: boolean
  primaryKey?: boolean
  default?: FieldDefault
  isTenantId?: boolean
  relation?: ReturnType<typeof parseRelationArgs>
} {
  const result: {
    optional?: boolean
    unique?: boolean
    primaryKey?: boolean
    default?: FieldDefault
    isTenantId?: boolean
    relation?: ReturnType<typeof parseRelationArgs>
  } = {}

  while (peekIs(lexer, 'at')) {
    lexer.next()
    const attr = expectIdent(lexer, 'attribute name')

    if (attr === 'id') {
      if (isRelation) {
        throw new DslParseError('UNEXPECTED_TOKEN', '@id is not valid on relations')
      }
      result.primaryKey = true
      continue
    }
    if (attr === 'unique') {
      if (isRelation) {
        throw new DslParseError('UNEXPECTED_TOKEN', '@unique is not valid on relations')
      }
      result.unique = true
      continue
    }
    if (attr === 'tenantId') {
      if (isRelation) {
        throw new DslParseError('UNEXPECTED_TOKEN', '@tenantId is not valid on relations')
      }
      result.isTenantId = true
      continue
    }
    if (attr === 'default') {
      if (isRelation) {
        throw new DslParseError('UNEXPECTED_TOKEN', '@default is not valid on relations')
      }
      expect(lexer, 'lparen', '(')
      result.default = parseDefaultValue(lexer)
      expect(lexer, 'rparen', ')')
      continue
    }
    if (attr === 'relation') {
      if (!isRelation) {
        throw new DslParseError('UNEXPECTED_TOKEN', '@relation is only valid on relation fields')
      }
      result.relation = parseRelationArgs(lexer)
      continue
    }

    throw new DslParseError('UNEXPECTED_TOKEN', `unknown attribute @${attr}`)
  }

  return result
}

function parseTypeAndModifiers(lexer: Lexer): {
  typeName: string
  optional: boolean
  list: boolean
  position: DslSourcePosition
} {
  const typeToken = expect(lexer, 'ident', 'type name')
  let optional = false
  let list = false

  if (peekIs(lexer, 'question')) {
    lexer.next()
    optional = true
  } else if (peekIs(lexer, 'lbrack')) {
    lexer.next()
    expect(lexer, 'rbrack', ']')
    list = true
  }

  return {
    typeName: typeToken.value,
    optional,
    list,
    position: typeToken.position,
  }
}

function parseModelMember(lexer: Lexer): ParsedFieldOrRelation | null {
  if (peekIs(lexer, 'rbrace') || peekIs(lexer, 'eof') || peekIs(lexer, 'atat')) {
    return null
  }

  const name = expectIdent(lexer, 'field name')
  const typeInfo = parseTypeAndModifiers(lexer)
  const typeName = typeInfo.typeName

  if (!isScalarFieldType(typeName)) {
    const attrs = parseFieldAttributes(lexer, true)
    if (attrs.relation === undefined) {
      throw new DslParseError(
        'INVALID_RELATION_KIND',
        `relation field "${name}" requires @relation(kind = ...)`,
        typeInfo.position,
      )
    }
    const relation: RelationDefinition = {
      name,
      kind: attrs.relation.kind,
      target: typeName,
      ...(attrs.relation.fields !== undefined ? { fields: attrs.relation.fields } : {}),
      ...(attrs.relation.references !== undefined ? { references: attrs.relation.references } : {}),
      ...(typeInfo.optional ? { optional: true } : {}),
    }
    return { kind: 'relation', relation }
  }

  const attrs = parseFieldAttributes(lexer, false)
  const field: FieldDefinition = {
    name,
    type: typeName,
    ...(typeInfo.optional ? { optional: true } : {}),
    ...(typeInfo.list ? { list: true } : {}),
    ...(attrs.unique === true ? { unique: true } : {}),
    ...(attrs.primaryKey === true ? { primaryKey: true } : {}),
    ...(attrs.default !== undefined ? { default: attrs.default } : {}),
    ...(attrs.isTenantId === true ? { isTenantId: true } : {}),
  }
  return { kind: 'field', field }
}

function parseModelBlock(lexer: Lexer, name: string): EntityDefinition {
  expect(lexer, 'lbrace', '{')

  const fields: FieldDefinition[] = []
  const relations: RelationDefinition[] = []
  let global = false
  let tenancyModel: ConcreteTenancyModel | undefined

  while (!peekIs(lexer, 'rbrace') && !peekIs(lexer, 'eof')) {
    if (peekIs(lexer, 'atat')) {
      lexer.next()
      const attr = expectIdent(lexer, 'block attribute')
      if (attr === 'global') {
        global = true
      } else if (attr === 'tenancy') {
        expect(lexer, 'lparen', '(')
        tenancyModel = parseConcreteTenancyModel(lexer)
        expect(lexer, 'rparen', ')')
      } else {
        throw new DslParseError('UNEXPECTED_TOKEN', `unknown block attribute @@${attr}`)
      }
      continue
    }

    const member = parseModelMember(lexer)
    if (member === null) {
      break
    }
    if (member.kind === 'field') {
      fields.push(member.field)
    } else {
      relations.push(member.relation)
    }
  }

  expect(lexer, 'rbrace', '}')

  return {
    name,
    fields,
    ...(relations.length > 0 ? { relations } : {}),
    ...(global ? { global: true } : {}),
    ...(tenancyModel !== undefined ? { tenancyModel } : {}),
  }
}

function parseServiceBlock(lexer: Lexer, name: string): ServiceDefinition {
  expect(lexer, 'lbrace', '{')

  let tenancyModel: ConcreteTenancyModel | undefined
  let entities: string[] | undefined

  while (!peekIs(lexer, 'rbrace') && !peekIs(lexer, 'eof')) {
    const key = expectIdent(lexer)
    expect(lexer, 'eq', '=')
    if (key === 'tenancy') {
      tenancyModel = parseConcreteTenancyModel(lexer)
    } else if (key === 'entities') {
      entities = parseIdentList(lexer)
    } else {
      throw new DslParseError('INVALID_BLOCK', `unknown service property "${key}"`)
    }
  }

  expect(lexer, 'rbrace', '}')

  if (tenancyModel === undefined) {
    throw new DslParseError('MISSING_TENANCY', `service "${name}" requires tenancy = ...`)
  }

  return {
    name,
    tenancyModel,
    ...(entities !== undefined ? { entities } : {}),
  }
}

function parseDocument(lexer: Lexer): SchemaAst {
  let schemaName: string | undefined
  let tenancy: SchemaTenancy | undefined
  const entities: EntityDefinition[] = []
  const services: ServiceDefinition[] = []

  while (!peekIs(lexer, 'eof')) {
    const keyword = expectIdent(lexer, 'top-level keyword')

    if (keyword === 'schema') {
      if (schemaName !== undefined) {
        throw new DslParseError('DUPLICATE_SCHEMA', 'schema block declared more than once')
      }
      schemaName = expectIdent(lexer, 'schema name')
      expect(lexer, 'lbrace', '{')
      const inner = expectIdent(lexer)
      if (inner !== 'tenancy') {
        throw new DslParseError(
          'MISSING_TENANCY',
          'schema block must contain a tenancy { ... } section',
        )
      }
      tenancy = parseTenancyBlock(lexer)
      expect(lexer, 'rbrace', '}')
      continue
    }

    if (keyword === 'model') {
      const name = expectIdent(lexer, 'model name')
      entities.push(parseModelBlock(lexer, name))
      continue
    }

    if (keyword === 'service') {
      const name = expectIdent(lexer, 'service name')
      services.push(parseServiceBlock(lexer, name))
      continue
    }

    throw new DslParseError(
      'UNEXPECTED_TOKEN',
      `unexpected top-level keyword "${keyword}" (expected schema|model|service)`,
    )
  }

  if (schemaName === undefined || tenancy === undefined) {
    throw new DslParseError('MISSING_SCHEMA', 'DSL requires a schema { tenancy { ... } } block')
  }

  return {
    name: schemaName,
    tenancy,
    entities,
    ...(services.length > 0 ? { services } : {}),
  }
}

/**
 * Parse a tenant-forge schema DSL source string into a SchemaAst.
 * Validates against AST invariants by default.
 */
export function parseSchema(source: string, options?: ParseSchemaOptions): SchemaAst {
  const lexer = createLexer(source)
  const ast = parseDocument(lexer)
  const shouldValidate = options?.validate !== false
  if (shouldValidate) {
    assertValidSchema(ast)
  }
  return ast
}
