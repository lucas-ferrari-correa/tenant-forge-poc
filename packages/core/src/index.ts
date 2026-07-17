/** Engine package placeholder — AST / DSL / query live here in later phases. */
export const CORE_PACKAGE = '@tenant-forge/core' as const

export function coreVersion(): string {
  return '0.0.0'
}

export { CONTAINER_IMAGES, type SupportedDatabase } from './containers.js'
