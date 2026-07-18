import { resolveEntityTenancy, TenancyResolutionError } from '../ast/resolve.js'
import type { ConcreteTenancyModel } from '../ast/tenancy.js'
import {
  requiresTenantIdColumn,
  TENANT_ID_FIELD_NAME,
  usesPhysicalIsolation,
  usesSchemaIsolation,
} from '../ast/tenancy.js'
import {
  assertNoUntrustedTenantAuthority,
  InvalidTenantContextError,
  isTrustedTenantSource,
  type TenantContext,
  UntrustedTenantAuthorityError,
  type UntrustedTenantInput,
} from '../ast/tenant-context.js'
import type { EntityDefinition, SchemaAst } from '../ast/types.js'
import { QueryBuildError } from './errors.js'
import type { IsolationStrategy, QueryData, QueryIntent, QueryIr, QueryWhere } from './types.js'
import { isQueryOperation } from './types.js'

export type BuildQueryOptions = {
  /**
   * Optional client channels to reject (doc 03 / 05).
   * When provided, any non-empty channel fails closed.
   */
  untrustedInput?: UntrustedTenantInput
}

function findEntity(ast: SchemaAst, entityName: string): EntityDefinition | undefined {
  return ast.entities.find((entity) => entity.name === entityName)
}

/** Sanitize tenant id for schema/database identifiers (adapter hint only). */
function sanitizeTenantIdentifier(tenantId: string): string {
  const sanitized = tenantId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return sanitized.length > 0 ? sanitized : 'tenant'
}

function assertTrustedContext(context: TenantContext): void {
  if (typeof context.tenantId !== 'string' || context.tenantId.trim().length === 0) {
    throw new QueryBuildError('INVALID_TENANT_CONTEXT', 'tenantId must be a non-empty string')
  }
  if (!isTrustedTenantSource(context.source)) {
    throw new QueryBuildError(
      'INVALID_TENANT_CONTEXT',
      `untrusted or unknown tenant context source: ${String(context.source)}`,
    )
  }
}

/**
 * Rejects client-supplied tenant_id in where/data (never authoritative — doc 03).
 */
function assertNoClientTenantIdAuthority(
  where: QueryWhere | undefined,
  data: QueryData | undefined,
): void {
  if (where !== undefined && Object.hasOwn(where, TENANT_ID_FIELD_NAME)) {
    throw new QueryBuildError(
      'CLIENT_TENANT_ID_FORBIDDEN',
      `refusing ${TENANT_ID_FIELD_NAME} in where; derive tenant from TenantContext only`,
    )
  }
  if (data !== undefined && Object.hasOwn(data, TENANT_ID_FIELD_NAME)) {
    throw new QueryBuildError(
      'CLIENT_TENANT_ID_FORBIDDEN',
      `refusing ${TENANT_ID_FIELD_NAME} in data; derive tenant from TenantContext only`,
    )
  }
}

function buildIsolation(model: ConcreteTenancyModel, tenantId: string): IsolationStrategy {
  if (requiresTenantIdColumn(model)) {
    return {
      kind: 'tenant-id-filter',
      tenantId,
      fieldName: TENANT_ID_FIELD_NAME,
      rls: { sessionVar: 'app.current_tenant_id' },
      mongo: { shardKey: TENANT_ID_FIELD_NAME },
    }
  }
  if (usesSchemaIsolation(model)) {
    const slug = sanitizeTenantIdentifier(tenantId)
    return {
      kind: 'schema-per-tenant',
      tenantId,
      schemaName: `tenant_${slug}`,
    }
  }
  if (usesPhysicalIsolation(model)) {
    const slug = sanitizeTenantIdentifier(tenantId)
    return {
      kind: 'database-per-tenant',
      tenantId,
      databaseName: `tenant_${slug}`,
      mongo: { databasePerTenant: true },
    }
  }
  throw new QueryBuildError(
    'TENANCY_UNRESOLVABLE',
    `no isolation strategy for concrete model: ${String(model)}`,
  )
}

function mergeWhereForPool(where: QueryWhere | undefined, tenantId: string): QueryWhere {
  return Object.freeze({
    ...(where ?? {}),
    [TENANT_ID_FIELD_NAME]: tenantId,
  })
}

function mergeDataForPool(
  operation: QueryIntent['operation'],
  data: QueryData | undefined,
  tenantId: string,
): QueryData | undefined {
  if (operation === 'create' || operation === 'update') {
    return Object.freeze({
      ...(data ?? {}),
      [TENANT_ID_FIELD_NAME]: tenantId,
    })
  }
  return data !== undefined ? Object.freeze({ ...data }) : undefined
}

function freezeIr(ir: QueryIr): QueryIr {
  return Object.freeze(ir)
}

/**
 * Builds a dialect-agnostic QueryIr from schema AST + trusted TenantContext + intent.
 * Fail-closed on invalid context, unknown entity, unresolvable tenancy, or client tenant authority.
 */
export function buildQuery(
  ast: SchemaAst,
  context: TenantContext,
  intent: QueryIntent,
  options?: BuildQueryOptions,
): QueryIr {
  try {
    assertTrustedContext(context)
  } catch (error) {
    if (error instanceof QueryBuildError) {
      throw error
    }
    if (error instanceof InvalidTenantContextError) {
      throw new QueryBuildError('INVALID_TENANT_CONTEXT', error.message)
    }
    throw error
  }

  if (options?.untrustedInput !== undefined) {
    try {
      assertNoUntrustedTenantAuthority(options.untrustedInput)
    } catch (error) {
      if (error instanceof UntrustedTenantAuthorityError) {
        throw new QueryBuildError('UNTRUSTED_TENANT_AUTHORITY', error.message)
      }
      throw error
    }
  }

  if (!isQueryOperation(intent.operation)) {
    throw new QueryBuildError(
      'INVALID_OPERATION',
      `unknown query operation: ${String(intent.operation)}`,
    )
  }

  const entity = findEntity(ast, intent.entity)
  if (entity === undefined) {
    throw new QueryBuildError('UNKNOWN_ENTITY', `unknown entity: ${intent.entity}`)
  }

  assertNoClientTenantIdAuthority(intent.where, intent.data)

  if (entity.global === true) {
    const isolation: IsolationStrategy = { kind: 'none' }
    return freezeIr({
      operation: intent.operation,
      entity: entity.name,
      tenancyModel: 'global',
      isolation,
      where: Object.freeze({ ...(intent.where ?? {}) }),
      ...(intent.data !== undefined ? { data: Object.freeze({ ...intent.data }) } : {}),
    })
  }

  let concreteModel: ConcreteTenancyModel
  try {
    concreteModel = resolveEntityTenancy(ast, entity.name)
  } catch (error) {
    if (error instanceof TenancyResolutionError) {
      throw new QueryBuildError('TENANCY_UNRESOLVABLE', error.message)
    }
    throw error
  }

  const isolation = buildIsolation(concreteModel, context.tenantId)
  const isPool = isolation.kind === 'tenant-id-filter'

  const where = isPool
    ? mergeWhereForPool(intent.where, context.tenantId)
    : Object.freeze({ ...(intent.where ?? {}) })

  const data = isPool
    ? mergeDataForPool(intent.operation, intent.data, context.tenantId)
    : intent.data !== undefined
      ? Object.freeze({ ...intent.data })
      : undefined

  return freezeIr({
    operation: intent.operation,
    entity: entity.name,
    tenancyModel: concreteModel,
    isolation,
    where,
    ...(data !== undefined ? { data } : {}),
  })
}

export type QueryBuilder = {
  build: (intent: QueryIntent, options?: BuildQueryOptions) => QueryIr
}

/**
 * Stateful helper: bind SchemaAst + TenantContext once, build many intents.
 */
export function createQueryBuilder(ast: SchemaAst, context: TenantContext): QueryBuilder {
  return {
    build(intent: QueryIntent, options?: BuildQueryOptions): QueryIr {
      return buildQuery(ast, context, intent, options)
    },
  }
}
