/**
 * Trusted tenant context contract (doc 03-seguranca-e-isolamento).
 * `tenant_id` is derived only from verified claims — never from client input as authority.
 */

export const TRUSTED_TENANT_SOURCES = ['jwt-claim', 'verified-session', 'control-plane'] as const

export type TrustedTenantSource = (typeof TRUSTED_TENANT_SOURCES)[number]

export type TenantContext = {
  readonly tenantId: string
  readonly source: TrustedTenantSource
}

export type CreateTenantContextInput = {
  tenantId: string
  source: TrustedTenantSource
}

/**
 * Client-supplied channels that must never authoritatively set the tenant.
 * Present so callers can fail closed instead of silently trusting them.
 */
export type UntrustedTenantInput = {
  header?: string
  queryParam?: string
  bodyField?: string
  clientPayload?: string
}

export class UntrustedTenantAuthorityError extends Error {
  readonly code = 'UNTRUSTED_TENANT_AUTHORITY' as const

  constructor(message: string = 'tenant_id from client input is not authoritative') {
    super(message)
    this.name = 'UntrustedTenantAuthorityError'
  }
}

export class InvalidTenantContextError extends Error {
  readonly code = 'INVALID_TENANT_CONTEXT' as const

  constructor(message: string) {
    super(message)
    this.name = 'InvalidTenantContextError'
  }
}

export function isTrustedTenantSource(value: string): value is TrustedTenantSource {
  return (TRUSTED_TENANT_SOURCES as readonly string[]).includes(value)
}

/**
 * Builds a TenantContext from a verified claim only.
 * Rejects empty ids and unknown sources.
 */
export function createTenantContext(input: CreateTenantContextInput): TenantContext {
  const tenantId = input.tenantId.trim()
  if (tenantId.length === 0) {
    throw new InvalidTenantContextError('tenantId must be a non-empty string')
  }
  if (!isTrustedTenantSource(input.source)) {
    throw new InvalidTenantContextError(`untrusted or unknown source: ${String(input.source)}`)
  }
  return Object.freeze({
    tenantId,
    source: input.source,
  })
}

/**
 * Fail-closed guard: any non-empty client-supplied tenant channel is rejected.
 * Call this when wiring HTTP/gateway adapters so client headers never become context.
 */
export function assertNoUntrustedTenantAuthority(input: UntrustedTenantInput): void {
  const channels: Array<keyof UntrustedTenantInput> = [
    'header',
    'queryParam',
    'bodyField',
    'clientPayload',
  ]
  for (const channel of channels) {
    const value = input[channel]
    if (typeof value === 'string' && value.trim().length > 0) {
      throw new UntrustedTenantAuthorityError(
        `refusing client-supplied tenant via ${channel}; derive tenant_id from a verified claim only`,
      )
    }
  }
}

/**
 * Convenience: create context from JWT claim after middleware verified the signature.
 * Does not accept raw headers — pass the already-extracted claim value.
 */
export function tenantContextFromJwtClaim(tenantId: string): TenantContext {
  return createTenantContext({ tenantId, source: 'jwt-claim' })
}
