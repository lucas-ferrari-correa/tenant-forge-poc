import { CORE_PACKAGE, coreVersion } from '@tenant-forge/core'

/** Typed ORM client placeholder — codegen arrives in Phase 13. */
export const SDK_PACKAGE = '@tenant-forge/sdk' as const

export function sdkInfo(): { sdk: string; engine: string; version: string } {
  return {
    sdk: SDK_PACKAGE,
    engine: CORE_PACKAGE,
    version: coreVersion(),
  }
}
