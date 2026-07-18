/** Engine package — AST is the in-memory source of truth; DSL/query project from it. */
export const CORE_PACKAGE = '@tenant-forge/core' as const

export function coreVersion(): string {
  return '0.0.0'
}

export * from './adapters/index.js'
export * from './ast/index.js'
export { CONTAINER_IMAGES, type SupportedDatabase } from './containers.js'
export * from './diff/index.js'
export * from './dsl/index.js'
export * from './migrate/index.js'
export * from './pull/index.js'
export * from './push/index.js'
export * from './query/index.js'
