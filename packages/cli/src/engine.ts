import {
  migrateTenancy,
  parseSchema,
  pullSchema,
  pushSchema,
  serializeSchema,
} from '@tenant-forge/core'

/** Public engine surface consumed by the CLI. Injectable so commands are unit-testable. */
export type Engine = {
  parseSchema: typeof parseSchema
  serializeSchema: typeof serializeSchema
  pushSchema: typeof pushSchema
  pullSchema: typeof pullSchema
  migrateTenancy: typeof migrateTenancy
}

export const realEngine: Engine = {
  parseSchema,
  serializeSchema,
  pushSchema,
  pullSchema,
  migrateTenancy,
}
