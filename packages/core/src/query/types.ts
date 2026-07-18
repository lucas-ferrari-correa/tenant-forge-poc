import type { ConcreteTenancyModel, TENANT_ID_FIELD_NAME } from '../ast/tenancy.js'

/** CRUD ops sufficient for the POC — dialect-agnostic. */
export const QUERY_OPERATIONS = ['findMany', 'findFirst', 'create', 'update', 'delete'] as const

export type QueryOperation = (typeof QUERY_OPERATIONS)[number]

/**
 * Isolation strategy slots for future adapters (no SQL/Mongo executed here).
 * Discriminated by `kind`; adapters map each kind to dialeto/protocolo.
 */
export type IsolationStrategy =
  | {
      /** @@global entities — no tenant injection. */
      kind: 'none'
    }
  | {
      /** shared-db-shared-schema (pool): WHERE tenant_id + RLS hint. */
      kind: 'tenant-id-filter'
      tenantId: string
      fieldName: typeof TENANT_ID_FIELD_NAME
      /** Postgres adapter: SET app.current_tenant_id / current_setting. */
      rls: { sessionVar: 'app.current_tenant_id' }
      /** Mongo adapter (pool): shard key / equality on tenant_id. */
      mongo: { shardKey: typeof TENANT_ID_FIELD_NAME }
    }
  | {
      /** shared-db-isolated-schema (bridge): schema / search_path per tenant. */
      kind: 'schema-per-tenant'
      tenantId: string
      schemaName: string
    }
  | {
      /** single-tenant (silo): dedicated database / instance. */
      kind: 'database-per-tenant'
      tenantId: string
      databaseName: string
      /** Mongo adapter (silo): database-per-tenant. */
      mongo: { databasePerTenant: true }
    }

export type QueryWhere = Readonly<Record<string, unknown>>

export type QueryData = Readonly<Record<string, unknown>>

/** Caller intent — tenant_id must never appear as authoritative input. */
export type QueryIntent = {
  operation: QueryOperation
  entity: string
  where?: QueryWhere
  data?: QueryData
}

/**
 * Dialect-agnostic query IR.
 * Adapters (Fase 5+) translate `isolation` + `where`/`data` to SQL/Mongo.
 */
export type QueryIr = {
  readonly operation: QueryOperation
  readonly entity: string
  /** Concrete model after resolveEntityTenancy, or `global` when entity.global. */
  readonly tenancyModel: ConcreteTenancyModel | 'global'
  readonly isolation: IsolationStrategy
  readonly where: QueryWhere
  readonly data?: QueryData
}

export function isQueryOperation(value: string): value is QueryOperation {
  return (QUERY_OPERATIONS as readonly string[]).includes(value)
}
