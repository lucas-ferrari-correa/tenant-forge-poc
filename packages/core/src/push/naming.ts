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

/** Bridge / silo namespace: `tenant_${slug}` — same convention as IsolationStrategy. */
export function tenantNamespace(tenantId: string): string {
  return `tenant_${sanitizeTenantIdentifier(tenantId)}`
}

export function assertSafeIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new SchemaPushError('INVALID_IDENTIFIER', `unsafe identifier: ${JSON.stringify(name)}`)
  }
  return name
}
