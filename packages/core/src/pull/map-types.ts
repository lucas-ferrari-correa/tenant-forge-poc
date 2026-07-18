import type { ScalarFieldType } from '../ast/types.js'

/**
 * Map native SQL / BSON type names to AST scalars (pragmatic subset).
 * Returns undefined when unmappable — caller may fall back to String + warning.
 */
export function mapNativeTypeToScalar(nativeType: string): ScalarFieldType | undefined {
  const t = nativeType.trim().toLowerCase()

  if (
    t === 'text' ||
    t === 'varchar' ||
    t === 'character varying' ||
    t === 'character' ||
    t === 'char' ||
    t === 'nvarchar' ||
    t === 'longtext' ||
    t === 'mediumtext' ||
    t === 'tinytext' ||
    t === 'citext' ||
    t.startsWith('varchar(') ||
    t.startsWith('character varying(') ||
    t.startsWith('char(') ||
    t.startsWith('character(')
  ) {
    return 'String'
  }

  if (t === 'uuid' || t === 'uniqueidentifier') {
    return 'Uuid'
  }

  if (
    t === 'integer' ||
    t === 'int' ||
    t === 'int4' ||
    t === 'int2' ||
    t === 'smallint' ||
    t === 'serial' ||
    t === 'smallserial' ||
    t === 'mediumint'
  ) {
    return 'Int'
  }

  if (t === 'bigint' || t === 'int8' || t === 'bigserial') {
    return 'BigInt'
  }

  if (
    t === 'double precision' ||
    t === 'float8' ||
    t === 'float4' ||
    t === 'real' ||
    t === 'double' ||
    t === 'float' ||
    t.startsWith('float(')
  ) {
    return 'Float'
  }

  if (t === 'numeric' || t === 'decimal' || t.startsWith('numeric(') || t.startsWith('decimal(')) {
    return 'Decimal'
  }

  if (t === 'boolean' || t === 'bool' || t === 'tinyint(1)') {
    return 'Boolean'
  }

  // MySQL TINYINT without (1) — treat as Int
  if (t === 'tinyint' || t.startsWith('tinyint(')) {
    return 'Int'
  }

  if (
    t === 'timestamp' ||
    t === 'timestamptz' ||
    t === 'timestamp with time zone' ||
    t === 'timestamp without time zone' ||
    t === 'datetime' ||
    t.startsWith('timestamp(') ||
    t.startsWith('datetime(') ||
    t === 'date'
  ) {
    return 'DateTime'
  }

  if (t === 'json' || t === 'jsonb') {
    return 'Json'
  }

  if (
    t === 'bytea' ||
    t === 'blob' ||
    t === 'longblob' ||
    t === 'mediumblob' ||
    t === 'tinyblob' ||
    t === 'binary' ||
    t === 'varbinary' ||
    t.startsWith('binary(') ||
    t.startsWith('varbinary(')
  ) {
    return 'Bytes'
  }

  // BSON / Mongo inferred labels
  if (t === 'string' || t === 'objectid') {
    return 'String'
  }
  if (t === 'int32' || t === 'number') {
    return 'Int'
  }
  if (t === 'int64' || t === 'long') {
    return 'BigInt'
  }
  if (t === 'double' || t === 'decimal128') {
    return t === 'decimal128' ? 'Decimal' : 'Float'
  }
  if (t === 'bool' || t === 'boolean') {
    return 'Boolean'
  }
  if (t === 'date') {
    return 'DateTime'
  }
  if (t === 'object' || t === 'array') {
    return 'Json'
  }
  if (t === 'bindata' || t === 'binary') {
    return 'Bytes'
  }

  return undefined
}

export function inferBsonType(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null'
  }
  if (typeof value === 'string') {
    return 'string'
  }
  if (typeof value === 'boolean') {
    return 'boolean'
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int32' : 'double'
  }
  if (typeof value === 'bigint') {
    return 'int64'
  }
  if (value instanceof Date) {
    return 'date'
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return 'binData'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  if (typeof value === 'object') {
    const ctor = (value as { _bsontype?: string; constructor?: { name?: string } })._bsontype
    if (
      ctor === 'ObjectId' ||
      (value as { constructor?: { name?: string } }).constructor?.name === 'ObjectId'
    ) {
      return 'objectId'
    }
    if (
      ctor === 'Long' ||
      (value as { constructor?: { name?: string } }).constructor?.name === 'Long'
    ) {
      return 'int64'
    }
    if (
      ctor === 'Decimal128' ||
      (value as { constructor?: { name?: string } }).constructor?.name === 'Decimal128'
    ) {
      return 'decimal128'
    }
    return 'object'
  }
  return 'string'
}
