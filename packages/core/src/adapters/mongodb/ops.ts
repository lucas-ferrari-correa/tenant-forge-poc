import type { Document } from 'mongodb'
import type { QueryIr } from '../../query/types.js'
import { MongodbAdapterError } from './errors.js'

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export type MongodbCompiledOp =
  | { kind: 'findMany'; filter: Document }
  | { kind: 'findFirst'; filter: Document }
  | { kind: 'create'; document: Document }
  | { kind: 'update'; filter: Document; update: { $set: Document } }
  | { kind: 'delete'; filter: Document }

/** Validate collection / field names before using them as Mongo identifiers. */
export function assertSafeIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new MongodbAdapterError(
      'INVALID_IDENTIFIER',
      `unsafe Mongo identifier: ${JSON.stringify(name)}`,
    )
  }
  return name
}

function equalityFilter(record: Readonly<Record<string, unknown>>): Document {
  const filter: Document = {}
  for (const [key, value] of Object.entries(record)) {
    assertSafeIdent(key)
    filter[key] = value
  }
  return filter
}

/**
 * Translate dialect-agnostic QueryIr into native Mongo operation descriptors.
 * Isolation (db selection / silo client) is applied by the executor — not here.
 * Pool: where/data already carry tenant_id (+ shardKey hint on isolation.mongo).
 */
export function compileQueryIr(ir: QueryIr): MongodbCompiledOp {
  assertSafeIdent(ir.entity)

  switch (ir.operation) {
    case 'findMany':
      return { kind: 'findMany', filter: equalityFilter(ir.where) }
    case 'findFirst':
      return { kind: 'findFirst', filter: equalityFilter(ir.where) }
    case 'create': {
      if (ir.data === undefined || Object.keys(ir.data).length === 0) {
        throw new MongodbAdapterError('MISSING_DATA', 'create requires non-empty data')
      }
      const document: Document = {}
      for (const [key, value] of Object.entries(ir.data)) {
        assertSafeIdent(key)
        document[key] = value
      }
      return { kind: 'create', document }
    }
    case 'update': {
      if (ir.data === undefined || Object.keys(ir.data).length === 0) {
        throw new MongodbAdapterError('MISSING_DATA', 'update requires non-empty data')
      }
      const set: Document = {}
      for (const [key, value] of Object.entries(ir.data)) {
        assertSafeIdent(key)
        set[key] = value
      }
      return { kind: 'update', filter: equalityFilter(ir.where), update: { $set: set } }
    }
    case 'delete':
      return { kind: 'delete', filter: equalityFilter(ir.where) }
    default: {
      const _exhaustive: never = ir.operation
      throw new MongodbAdapterError(
        'EXECUTION_FAILED',
        `unsupported operation: ${String(_exhaustive)}`,
      )
    }
  }
}

/**
 * Resolve which Mongo database to use for this IR.
 * Bridge → schemaName as namespace (pool-safe, no global USE).
 * Silo → isolation.databaseName (client may be silo-scoped).
 * Pool / global → default DB from the shared connection string.
 */
export function resolveDatabaseName(ir: QueryIr, defaultDatabase: string): string {
  switch (ir.isolation.kind) {
    case 'none':
    case 'tenant-id-filter':
      return defaultDatabase
    case 'schema-per-tenant':
      return assertSafeIdent(ir.isolation.schemaName)
    case 'database-per-tenant':
      return assertSafeIdent(ir.isolation.databaseName)
    default: {
      const _exhaustive: never = ir.isolation
      throw new MongodbAdapterError(
        'UNSUPPORTED_ISOLATION',
        `unsupported isolation: ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}
