import { SchemaPushError } from './errors.js'

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Sanitize tenant id for schema/database identifiers (mirrors query builder). */
export function sanitizeTenantIdentifier(tenantId: string): string {
  const sanitized = tenantId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return sanitized.length > 0 ? sanitized : 'tenant'
}

/** Bridge namespace: `tenant_${slug}` — schema (Postgres) or database (MySQL/Mongo). */
export function tenantNamespace(tenantId: string): string {
  return `tenant_${sanitizeTenantIdentifier(tenantId)}`
}

/** Silo namespace: `silo_${slug}` — dedicated database, distinct from bridge in all dialects. */
export function siloNamespace(tenantId: string): string {
  return `silo_${sanitizeTenantIdentifier(tenantId)}`
}

export function assertSafeIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new SchemaPushError('INVALID_IDENTIFIER', `unsafe identifier: ${JSON.stringify(name)}`)
  }
  return name
}
