import type { QueryIr } from '../../query/types.js'
import { PostgresAdapterError } from './errors.js'

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export type SqlStatement = {
  text: string
  values: unknown[]
}

/** Quote a SQL identifier after validating the name (no injection via entity/field keys). */
export function quoteIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new PostgresAdapterError(
      'INVALID_IDENTIFIER',
      `unsafe SQL identifier: ${JSON.stringify(name)}`,
    )
  }
  return `"${name}"`
}

function pushEqualityClauses(
  record: Readonly<Record<string, unknown>>,
  values: unknown[],
): string[] {
  const clauses: string[] = []
  for (const [key, value] of Object.entries(record)) {
    values.push(value)
    clauses.push(`${quoteIdent(key)} = $${values.length}`)
  }
  return clauses
}

/**
 * Translate dialect-agnostic QueryIr into a single parameterized Postgres statement.
 * Isolation (SET LOCAL / search_path / DB switch) is applied by the executor, not here.
 */
export function compileQueryIr(ir: QueryIr): SqlStatement {
  const table = quoteIdent(ir.entity)
  const values: unknown[] = []

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
        throw new PostgresAdapterError('MISSING_DATA', 'create requires non-empty data')
      }
      const columns: string[] = []
      const placeholders: string[] = []
      for (const [key, value] of Object.entries(ir.data)) {
        columns.push(quoteIdent(key))
        values.push(value)
        placeholders.push(`$${values.length}`)
      }
      return {
        text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
        values,
      }
    }
    case 'update': {
      if (ir.data === undefined || Object.keys(ir.data).length === 0) {
        throw new PostgresAdapterError('MISSING_DATA', 'update requires non-empty data')
      }
      const setClauses: string[] = []
      for (const [key, value] of Object.entries(ir.data)) {
        values.push(value)
        setClauses.push(`${quoteIdent(key)} = $${values.length}`)
      }
      const whereClauses = pushEqualityClauses(ir.where, values)
      const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : ''
      return {
        text: `UPDATE ${table} SET ${setClauses.join(', ')}${whereSql} RETURNING *`,
        values,
      }
    }
    case 'delete': {
      const whereClauses = pushEqualityClauses(ir.where, values)
      const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : ''
      return { text: `DELETE FROM ${table}${whereSql} RETURNING *`, values }
    }
    default: {
      const _exhaustive: never = ir.operation
      throw new PostgresAdapterError(
        'EXECUTION_FAILED',
        `unsupported operation: ${String(_exhaustive)}`,
      )
    }
  }
}
