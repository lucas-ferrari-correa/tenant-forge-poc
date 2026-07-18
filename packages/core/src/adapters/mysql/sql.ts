import type { QueryIr } from '../../query/types.js'
import { MysqlAdapterError } from './errors.js'

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Scalar params accepted by mysql2 prepared statements. */
export type SqlParam = string | number | bigint | boolean | Date | null | Buffer | Uint8Array

export type SqlStatement = {
  text: string
  values: SqlParam[]
}

function asSqlParam(value: unknown): SqlParam {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean' ||
    value instanceof Date ||
    value instanceof Buffer ||
    value instanceof Uint8Array
  ) {
    return value
  }
  throw new MysqlAdapterError('EXECUTION_FAILED', `unsupported SQL parameter type: ${typeof value}`)
}

/** Quote a SQL identifier with backticks after validating the name. */
export function quoteIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new MysqlAdapterError(
      'INVALID_IDENTIFIER',
      `unsafe SQL identifier: ${JSON.stringify(name)}`,
    )
  }
  return `\`${name}\``
}

/** Table ref — qualify with database when isolation is schema-per-tenant (MySQL DB ≈ schema). */
function tableRef(ir: QueryIr): string {
  const table = quoteIdent(ir.entity)
  if (ir.isolation.kind === 'schema-per-tenant') {
    return `${quoteIdent(ir.isolation.schemaName)}.${table}`
  }
  return table
}

function pushEqualityClauses(
  record: Readonly<Record<string, unknown>>,
  values: SqlParam[],
): string[] {
  const clauses: string[] = []
  for (const [key, value] of Object.entries(record)) {
    values.push(asSqlParam(value))
    clauses.push(`${quoteIdent(key)} = ?`)
  }
  return clauses
}

/** SELECT * matching equality record — used after mutations (MySQL has no RETURNING). */
export function compileSelectByRecord(
  ir: QueryIr,
  record: Readonly<Record<string, unknown>>,
): SqlStatement {
  const values: SqlParam[] = []
  const clauses = pushEqualityClauses(record, values)
  const whereSql = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  return { text: `SELECT * FROM ${tableRef(ir)}${whereSql}`, values }
}

/**
 * Translate dialect-agnostic QueryIr into a parameterized MySQL statement.
 * Mutations omit RETURNING — the adapter fetches rows via compileSelectByRecord.
 * Isolation (session var / DB qualify / silo pool) is applied by the executor.
 */
export function compileQueryIr(ir: QueryIr): SqlStatement {
  const table = tableRef(ir)
  const values: SqlParam[] = []

  switch (ir.operation) {
    case 'findMany': {
      const whereClauses = pushEqualityClauses(ir.where, values)
      const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : ''
      return { text: `SELECT * FROM ${table}${whereSql}`, values }
    }
    case 'findFirst': {
      const whereClauses = pushEqualityClauses(ir.where, values)
      const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : ''
      return { text: `SELECT * FROM ${table}${whereSql} LIMIT 1`, values }
    }
    case 'create': {
      if (ir.data === undefined || Object.keys(ir.data).length === 0) {
        throw new MysqlAdapterError('MISSING_DATA', 'create requires non-empty data')
      }
      const columns: string[] = []
      const placeholders: string[] = []
      for (const [key, value] of Object.entries(ir.data)) {
        columns.push(quoteIdent(key))
        values.push(asSqlParam(value))
        placeholders.push('?')
      }
      return {
        text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        values,
      }
    }
    case 'update': {
      if (ir.data === undefined || Object.keys(ir.data).length === 0) {
        throw new MysqlAdapterError('MISSING_DATA', 'update requires non-empty data')
      }
      const setClauses: string[] = []
      for (const [key, value] of Object.entries(ir.data)) {
        values.push(asSqlParam(value))
        setClauses.push(`${quoteIdent(key)} = ?`)
      }
      const whereClauses = pushEqualityClauses(ir.where, values)
      const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : ''
      return {
        text: `UPDATE ${table} SET ${setClauses.join(', ')}${whereSql}`,
        values,
      }
    }
    case 'delete': {
      const whereClauses = pushEqualityClauses(ir.where, values)
      const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : ''
      return { text: `DELETE FROM ${table}${whereSql}`, values }
    }
    default: {
      const _exhaustive: never = ir.operation
      throw new MysqlAdapterError(
        'EXECUTION_FAILED',
        `unsupported operation: ${String(_exhaustive)}`,
      )
    }
  }
}
