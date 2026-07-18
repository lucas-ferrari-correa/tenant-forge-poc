import type { FieldDefinition, RelationDefinition, ScalarFieldType } from '../ast/types.js'
import { SchemaPushError } from './errors.js'
import { assertSafeIdent } from './naming.js'

export type SqlDialect = 'postgres' | 'mysql'

function mapScalarType(dialect: SqlDialect, type: ScalarFieldType, isList: boolean): string {
  if (isList) {
    // POC: store lists as JSON documents (no native array DDL for MySQL).
    return dialect === 'postgres' ? 'JSONB' : 'JSON'
  }

  switch (type) {
    case 'String':
      return dialect === 'postgres' ? 'TEXT' : 'VARCHAR(255)'
    case 'Int':
      return dialect === 'postgres' ? 'INTEGER' : 'INT'
    case 'BigInt':
      return 'BIGINT'
    case 'Float':
      return dialect === 'postgres' ? 'DOUBLE PRECISION' : 'DOUBLE'
    case 'Decimal':
      return dialect === 'postgres' ? 'NUMERIC' : 'DECIMAL(65,30)'
    case 'Boolean':
      return dialect === 'postgres' ? 'BOOLEAN' : 'TINYINT(1)'
    case 'DateTime':
      return dialect === 'postgres' ? 'TIMESTAMPTZ' : 'DATETIME(3)'
    case 'Json':
      return dialect === 'postgres' ? 'JSONB' : 'JSON'
    case 'Bytes':
      return dialect === 'postgres' ? 'BYTEA' : 'BLOB'
    case 'Uuid':
      return dialect === 'postgres' ? 'UUID' : 'CHAR(36)'
    default: {
      const _exhaustive: never = type
      throw new SchemaPushError(
        'UNSUPPORTED_FIELD',
        `unsupported scalar type: ${String(_exhaustive)}`,
      )
    }
  }
}

function quoteIdent(dialect: SqlDialect, name: string): string {
  assertSafeIdent(name)
  return dialect === 'postgres' ? `"${name}"` : `\`${name}\``
}

function columnDefault(dialect: SqlDialect, field: FieldDefinition): string | undefined {
  if (field.default === undefined) {
    return undefined
  }
  switch (field.default.kind) {
    case 'literal': {
      const value = field.default.value
      if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
      }
      if (typeof value === 'boolean') {
        if (dialect === 'mysql') {
          return value ? '1' : '0'
        }
        return value ? 'TRUE' : 'FALSE'
      }
      return String(value)
    }
    case 'now':
      return dialect === 'postgres' ? 'CURRENT_TIMESTAMP' : 'CURRENT_TIMESTAMP(3)'
    case 'uuid':
      return dialect === 'postgres' ? 'gen_random_uuid()' : '(UUID())'
    case 'autoincrement':
      // Handled via SERIAL / AUTO_INCREMENT on the column type path.
      return undefined
    default: {
      const _exhaustive: never = field.default
      throw new SchemaPushError(
        'UNSUPPORTED_FIELD',
        `unsupported default: ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}

function columnSql(dialect: SqlDialect, field: FieldDefinition): string {
  const name = quoteIdent(dialect, field.name)
  const isAuto =
    field.default?.kind === 'autoincrement' &&
    (field.type === 'Int' || field.type === 'BigInt') &&
    field.list !== true

  let typeSql: string
  if (isAuto) {
    if (dialect === 'postgres') {
      typeSql = field.type === 'BigInt' ? 'BIGSERIAL' : 'SERIAL'
    } else {
      typeSql = `${field.type === 'BigInt' ? 'BIGINT' : 'INT'} AUTO_INCREMENT`
    }
  } else {
    typeSql = mapScalarType(dialect, field.type, field.list === true)
  }

  const parts: string[] = [`${name} ${typeSql}`]

  if (field.primaryKey === true) {
    parts.push('PRIMARY KEY')
  } else if (field.optional !== true) {
    parts.push('NOT NULL')
  }

  if (field.unique === true && field.primaryKey !== true) {
    parts.push('UNIQUE')
  }

  const def = columnDefault(dialect, field)
  if (def !== undefined && !isAuto) {
    parts.push(`DEFAULT ${def}`)
  }

  return parts.join(' ')
}

/**
 * Build CREATE TABLE IF NOT EXISTS for an entity (fields only; FKs added separately).
 * `qualifiedName` is already quoted (e.g. `"Task"` or `` `tenant_acme`.`Task` ``).
 */
export function compileCreateTableSql(
  dialect: SqlDialect,
  qualifiedName: string,
  fields: FieldDefinition[],
): string {
  if (fields.length === 0) {
    throw new SchemaPushError('UNSUPPORTED_FIELD', `entity table ${qualifiedName} has no fields`)
  }
  const columns = fields.map((field) => columnSql(dialect, field))
  return `CREATE TABLE IF NOT EXISTS ${qualifiedName} (\n  ${columns.join(',\n  ')}\n)`
}

export function compileTenantIdIndexSql(
  dialect: SqlDialect,
  tableName: string,
  qualifiedTable: string,
): string {
  assertSafeIdent(tableName)
  const indexName = quoteIdent(dialect, `${tableName}_tenant_id_idx`)
  const column = quoteIdent(dialect, 'tenant_id')
  // Postgres supports IF NOT EXISTS; MySQL 8.4 does not — caller tolerates duplicate errors.
  if (dialect === 'postgres') {
    return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${qualifiedTable} (${column})`
  }
  return `CREATE INDEX ${indexName} ON ${qualifiedTable} (${column})`
}

/**
 * Relations that hold FKs on this entity (many-to-one / one-to-one with fields).
 * Mongo has no FK — callers skip this for mongodb.
 */
export function relationsWithForeignKeys(
  relations: RelationDefinition[] | undefined,
): RelationDefinition[] {
  if (relations === undefined) {
    return []
  }
  return relations.filter((relation) => {
    if (relation.fields === undefined || relation.fields.length === 0) {
      return false
    }
    if (relation.references === undefined || relation.references.length === 0) {
      return false
    }
    return relation.kind === 'many-to-one' || relation.kind === 'one-to-one'
  })
}

export function compileForeignKeySql(
  dialect: SqlDialect,
  tableName: string,
  qualifiedTable: string,
  relation: RelationDefinition,
  /** Target table qualifier (schema.table or just table). */
  qualifiedTarget: string,
): string {
  assertSafeIdent(tableName)
  assertSafeIdent(relation.name)
  const fields = relation.fields ?? []
  const references = relation.references ?? []
  if (fields.length !== references.length) {
    throw new SchemaPushError(
      'UNSUPPORTED_FIELD',
      `relation ${relation.name} fields/references length mismatch`,
    )
  }
  const constraint = quoteIdent(dialect, `${tableName}_${relation.name}_fkey`)
  const localCols = fields.map((name) => quoteIdent(dialect, name)).join(', ')
  const refCols = references.map((name) => quoteIdent(dialect, name)).join(', ')
  return (
    `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraint} ` +
    `FOREIGN KEY (${localCols}) REFERENCES ${qualifiedTarget} (${refCols})`
  )
}

export function quoteSqlIdent(dialect: SqlDialect, name: string): string {
  return quoteIdent(dialect, name)
}
