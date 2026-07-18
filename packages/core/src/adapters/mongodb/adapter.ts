import { type Db, MongoClient, type Document as MongoDocument } from 'mongodb'
import type { IsolationStrategy, QueryIr } from '../../query/types.js'
import { MongodbAdapterError } from './errors.js'
import { assertSafeIdent, compileQueryIr, resolveDatabaseName } from './ops.js'

export type MongodbRow = Record<string, unknown>

export type MongodbExecuteResult = MongodbRow[] | MongodbRow | null

export type CreateMongodbAdapterOptions = {
  /**
   * Connection string for the shared/default database (pool, bridge, global).
   * Silo (`database-per-tenant`) rewrites the database name unless
   * `resolveSiloConnectionString` is provided.
   */
  connectionString: string
  /** Override how silo databases are reached (default: replace DB in connectionString). */
  resolveSiloConnectionString?: (databaseName: string) => string
}

export type MongodbAdapter = {
  execute(ir: QueryIr): Promise<MongodbExecuteResult>
  dispose(): Promise<void>
}

function rewriteDatabase(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString)
  url.pathname = `/${databaseName}`
  return url.toString()
}

function defaultDatabaseFromUri(connectionString: string): string {
  const url = new URL(connectionString)
  const path = url.pathname.replace(/^\//, '')
  return path.length > 0 ? path : 'test'
}

function stripMongoId(doc: MongoDocument | null): MongodbRow | null {
  if (doc === null) {
    return null
  }
  const { _id: _ignored, ...rest } = doc
  return rest as MongodbRow
}

function applyIsolationHints(isolation: IsolationStrategy): void {
  switch (isolation.kind) {
    case 'none':
    case 'schema-per-tenant':
    case 'database-per-tenant':
      return
    case 'tenant-id-filter': {
      // No server-side RLS in Mongo — isolation is the IR tenant_id filter + shardKey hint.
      // Hint is consumed by documentation/contract; equality is already on ir.where/data.
      void isolation.mongo.shardKey
      return
    }
    default: {
      const _exhaustive: never = isolation
      throw new MongodbAdapterError(
        'UNSUPPORTED_ISOLATION',
        `unsupported isolation: ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}

function mapResult(ir: QueryIr, rows: MongodbRow[]): MongodbExecuteResult {
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
      throw new MongodbAdapterError(
        'EXECUTION_FAILED',
        `unsupported operation: ${String(_exhaustive)}`,
      )
    }
  }
}

async function runOp(db: Db, ir: QueryIr): Promise<MongodbExecuteResult> {
  const collection = db.collection(assertSafeIdent(ir.entity))
  const op = compileQueryIr(ir)

  switch (op.kind) {
    case 'findMany': {
      const docs = await collection.find(op.filter).toArray()
      return mapResult(
        ir,
        docs.map((doc) => stripMongoId(doc)).filter((row): row is MongodbRow => row !== null),
      )
    }
    case 'findFirst': {
      const doc = await collection.findOne(op.filter)
      return mapResult(ir, doc === null ? [] : [stripMongoId(doc) as MongodbRow])
    }
    case 'create': {
      await collection.insertOne(op.document)
      return mapResult(ir, [stripMongoId(op.document) as MongodbRow])
    }
    case 'update': {
      const doc = await collection.findOneAndUpdate(op.filter, op.update, {
        returnDocument: 'after',
      })
      return mapResult(ir, doc === null ? [] : [stripMongoId(doc) as MongodbRow])
    }
    case 'delete': {
      const doc = await collection.findOneAndDelete(op.filter)
      return mapResult(ir, doc === null ? [] : [stripMongoId(doc) as MongodbRow])
    }
    default: {
      const _exhaustive: never = op
      throw new MongodbAdapterError(
        'EXECUTION_FAILED',
        `unsupported compiled op: ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}

/**
 * MongoDB adapter: translates QueryIr → native ops and applies isolation from the IR.
 * Does not re-resolve tenancy — fail-closed authority stays in the query builder.
 * Mongo has no RLS: pool isolation is the tenant_id filter already on the IR.
 */
export function createMongodbAdapter(options: CreateMongodbAdapterOptions): MongodbAdapter {
  const sharedClient = new MongoClient(options.connectionString)
  const siloClients = new Map<string, MongoClient>()
  const defaultDatabase = defaultDatabaseFromUri(options.connectionString)
  let sharedConnected = false

  const resolveSilo =
    options.resolveSiloConnectionString ??
    ((databaseName: string) => rewriteDatabase(options.connectionString, databaseName))

  async function clientFor(ir: QueryIr): Promise<MongoClient> {
    if (ir.isolation.kind === 'database-per-tenant') {
      const dbName = ir.isolation.databaseName
      // Contract: silo IR always carries mongo.databasePerTenant: true.
      void ir.isolation.mongo.databasePerTenant
      let client = siloClients.get(dbName)
      if (client === undefined) {
        client = new MongoClient(resolveSilo(dbName))
        await client.connect()
        siloClients.set(dbName, client)
      }
      return client
    }
    if (!sharedConnected) {
      await sharedClient.connect()
      sharedConnected = true
    }
    return sharedClient
  }

  return {
    async execute(ir: QueryIr): Promise<MongodbExecuteResult> {
      try {
        applyIsolationHints(ir.isolation)
        const client = await clientFor(ir)
        const dbName = resolveDatabaseName(ir, defaultDatabase)
        const db = client.db(dbName)
        return await runOp(db, ir)
      } catch (error) {
        if (error instanceof MongodbAdapterError) {
          throw error
        }
        throw new MongodbAdapterError('EXECUTION_FAILED', 'mongodb query failed', {
          cause: error,
        })
      }
    },

    async dispose(): Promise<void> {
      await sharedClient.close()
      sharedConnected = false
      await Promise.all([...siloClients.values()].map((client) => client.close()))
      siloClients.clear()
    },
  }
}
