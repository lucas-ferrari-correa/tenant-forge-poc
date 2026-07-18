import mysql from 'mysql2/promise'
import type { IsolationStrategy, QueryIr } from '../../query/types.js'
import { MysqlAdapterError } from './errors.js'
import { compileQueryIr, compileSelectByRecord } from './sql.js'

export type MysqlRow = Record<string, unknown>

export type MysqlExecuteResult = MysqlRow[] | MysqlRow | null

export type CreateMysqlAdapterOptions = {
  /**
   * Connection string for the shared/default database (pool, bridge, global).
   * Silo (`database-per-tenant`) rewrites the database name unless
   * `resolveSiloConnectionString` is provided.
   */
  connectionString: string
  /** Override how silo databases are reached (default: replace DB in connectionString). */
  resolveSiloConnectionString?: (databaseName: string) => string
}

export type MysqlAdapter = {
  execute(ir: QueryIr): Promise<MysqlExecuteResult>
  dispose(): Promise<void>
}

function rewriteDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString)
  url.pathname = `/${databaseName}`
  return url.toString()
}

/** Map IR sessionVar (`app.current_tenant_id`) to a MySQL user-variable name. */
function sessionUserVar(sessionVar: string): string {
  return `@${sessionVar.replace(/\./g, '_')}`
}

async function applyIsolation(
  connection: mysql.PoolConnection,
  isolation: IsolationStrategy,
): Promise<void> {
  switch (isolation.kind) {
    case 'none':
      return
    case 'tenant-id-filter': {
      // Session user-var for observability/parity with Postgres GUC — MySQL has no RLS.
      // Effective isolation is the tenant_id filter already present on the IR.
      await connection.execute(`SET ${sessionUserVar(isolation.rls.sessionVar)} = ?`, [
        isolation.tenantId,
      ])
      return
    }
    case 'schema-per-tenant':
      // Table qualification happens in compileQueryIr — no USE (pool-unsafe).
      return
    case 'database-per-tenant':
      // Handled by connecting to isolation.databaseName — no session prep.
      return
    default: {
      const _exhaustive: never = isolation
      throw new MysqlAdapterError(
        'UNSUPPORTED_ISOLATION',
        `unsupported isolation: ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}

function asRows(result: unknown): MysqlRow[] {
  if (!Array.isArray(result)) {
    return []
  }
  return result as MysqlRow[]
}

function mapResult(ir: QueryIr, rows: MysqlRow[]): MysqlExecuteResult {
  switch (ir.operation) {
    case 'findMany':
      return rows
    case 'findFirst':
    case 'create':
    case 'update':
    case 'delete':
      return rows[0] ?? null
    default: {
      const _exhaustive: never = ir.operation
      throw new MysqlAdapterError(
        'EXECUTION_FAILED',
        `unsupported operation: ${String(_exhaustive)}`,
      )
    }
  }
}

async function runStatement(
  connection: mysql.PoolConnection,
  ir: QueryIr,
): Promise<MysqlExecuteResult> {
  switch (ir.operation) {
    case 'findMany':
    case 'findFirst': {
      const statement = compileQueryIr(ir)
      const [raw] = await connection.execute(statement.text, statement.values)
      return mapResult(ir, asRows(raw))
    }
    case 'create': {
      if (ir.data === undefined) {
        throw new MysqlAdapterError('MISSING_DATA', 'create requires non-empty data')
      }
      const statement = compileQueryIr(ir)
      await connection.execute(statement.text, statement.values)
      const fetch = compileSelectByRecord(ir, ir.data)
      const [raw] = await connection.execute(fetch.text, fetch.values)
      return mapResult(ir, asRows(raw))
    }
    case 'update': {
      const statement = compileQueryIr(ir)
      await connection.execute(statement.text, statement.values)
      const fetch = compileSelectByRecord(ir, ir.where)
      const [raw] = await connection.execute(fetch.text, fetch.values)
      return mapResult(ir, asRows(raw))
    }
    case 'delete': {
      const fetch = compileSelectByRecord(ir, ir.where)
      const [before] = await connection.execute(fetch.text, fetch.values)
      const rows = asRows(before)
      if (rows.length === 0) {
        return null
      }
      const statement = compileQueryIr(ir)
      await connection.execute(statement.text, statement.values)
      return rows[0] ?? null
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

/**
 * MySQL/MariaDB adapter: translates QueryIr → SQL and applies isolation from the IR.
 * Does not re-resolve tenancy — fail-closed authority stays in the query builder.
 */
export function createMysqlAdapter(options: CreateMysqlAdapterOptions): MysqlAdapter {
  const sharedPool = mysql.createPool(options.connectionString)
  const siloPools = new Map<string, mysql.Pool>()

  const resolveSilo =
    options.resolveSiloConnectionString ??
    ((databaseName: string) => rewriteDatabase(options.connectionString, databaseName))

  function poolFor(ir: QueryIr): mysql.Pool {
    if (ir.isolation.kind === 'database-per-tenant') {
      const dbName = ir.isolation.databaseName
      let pool = siloPools.get(dbName)
      if (pool === undefined) {
        pool = mysql.createPool(resolveSilo(dbName))
        siloPools.set(dbName, pool)
      }
      return pool
    }
    return sharedPool
  }

  return {
    async execute(ir: QueryIr): Promise<MysqlExecuteResult> {
      const pool = poolFor(ir)
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        try {
          await applyIsolation(connection, ir.isolation)
          const result = await runStatement(connection, ir)
          await connection.commit()
          return result
        } catch (error) {
          await connection.rollback()
          if (error instanceof MysqlAdapterError) {
            throw error
          }
          throw new MysqlAdapterError('EXECUTION_FAILED', 'mysql query failed', {
            cause: error,
          })
        }
      } finally {
        connection.release()
      }
    },

    async dispose(): Promise<void> {
      await sharedPool.end()
      await Promise.all([...siloPools.values()].map((pool) => pool.end()))
      siloPools.clear()
    },
  }
}
