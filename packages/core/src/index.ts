/** Engine package — AST is the in-memory source of truth; DSL projects to/from it. */
export const CORE_PACKAGE = '@tenant-forge/core' as const

export function coreVersion(): string {
  return '0.0.0'
}

export * from './ast/index.js'
export { CONTAINER_IMAGES, type SupportedDatabase } from './containers.js'
export * from './dsl/index.js'
