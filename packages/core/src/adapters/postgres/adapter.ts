import pg from 'pg'
import type { IsolationStrategy, QueryIr } from '../../query/types.js'
import { PostgresAdapterError } from './errors.js'
import { compileQueryIr } from './sql.js'

const { Pool } = pg

export type PostgresRow = Record<string, unknown>

export type PostgresExecuteResult = PostgresRow[] | PostgresRow | null

export type CreatePostgresAdapterOptions = {
  /**
   * Connection string for the shared/default database (pool, bridge, global).
   * Silo (`database-per-tenant`) rewrites the database name unless
   * `resolveSiloConnectionString` is provided.
   */
  connectionString: string
  /** Override how silo databases are reached (default: replace DB in connectionString). */
  resolveSiloConnectionString?: (databaseName: string) => string
}

export type PostgresAdapter = {
  execute(ir: QueryIr): Promise<PostgresExecuteResult>
  dispose(): Promise<void>
}

function rewriteDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString)
  url.pathname = `/${databaseName}`
  return url.toString()
}

async function applyIsolation(client: pg.PoolClient, isolation: IsolationStrategy): Promise<void> {
  switch (isolation.kind) {
    case 'none':
      return
    case 'tenant-id-filter': {
      // Transaction-local GUC — survives pooling better than session SET (doc 03).
      await client.query('SELECT set_config($1, $2, true)', [
        isolation.rls.sessionVar,
        isolation.tenantId,
      ])
      return
    }
    case 'schema-per-tenant': {
      await client.query('SELECT set_config($1, $2, true)', [
        'search_path',
        `${isolation.schemaName}, public`,
      ])
      return
    }
    case 'database-per-tenant':
      // Handled by connecting to isolation.databaseName — no session prep.
      return
    default: {
      const _exhaustive: never = isolation
      throw new PostgresAdapterError(
        'UNSUPPORTED_ISOLATION',
        `unsupported isolation: ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}

function mapResult(ir: QueryIr, rows: PostgresRow[]): PostgresExecuteResult {
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
      throw new PostgresAdapterError(
        'EXECUTION_FAILED',
        `unsupported operation: ${String(_exhaustive)}`,
      )
    }
  }
}

/**
 * Postgres adapter: translates QueryIr → SQL and applies isolation from the IR.
 * Does not re-resolve tenancy — fail-closed authority stays in the query builder.
 */
export function createPostgresAdapter(options: CreatePostgresAdapterOptions): PostgresAdapter {
  const sharedPool = new Pool({ connectionString: options.connectionString })
  const siloPools = new Map<string, pg.Pool>()

  const resolveSilo =
    options.resolveSiloConnectionString ??
    ((databaseName: string) => rewriteDatabase(options.connectionString, databaseName))

  function poolFor(ir: QueryIr): pg.Pool {
    if (ir.isolation.kind === 'database-per-tenant') {
      const dbName = ir.isolation.databaseName
      let pool = siloPools.get(dbName)
      if (pool === undefined) {
        pool = new Pool({ connectionString: resolveSilo(dbName) })
        siloPools.set(dbName, pool)
      }
      return pool
    }
    return sharedPool
  }

  return {
    async execute(ir: QueryIr): Promise<PostgresExecuteResult> {
      const pool = poolFor(ir)
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        try {
          await applyIsolation(client, ir.isolation)
          const statement = compileQueryIr(ir)
          const result = await client.query(statement.text, statement.values)
          await client.query('COMMIT')
          const rows = result.rows as PostgresRow[]
          return mapResult(ir, rows)
        } catch (error) {
          await client.query('ROLLBACK')
          if (error instanceof PostgresAdapterError) {
            throw error
          }
          throw new PostgresAdapterError('EXECUTION_FAILED', 'postgres query failed', {
            cause: error,
          })
        }
      } finally {
        client.release()
      }
    },

    async dispose(): Promise<void> {
      await sharedPool.end()
      await Promise.all([...siloPools.values()].map((pool) => pool.end()))
      siloPools.clear()
    },
  }
}
