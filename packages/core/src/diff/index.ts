export {
  boolFlag,
  entityMetaEqual,
  fieldDefaultsEqual,
  fieldsEqual,
  indexByName,
  relationsEqual,
  schemaTenancyEqual,
  servicesEqual,
  snapshotEntityMeta,
  snapshotField,
  snapshotRelation,
  snapshotSchemaTenancy,
  snapshotService,
  stringArraysEqual,
} from './compare.js'
export {
  createSchemaDiffer,
  diffSchemaAgainstDb,
  diffSchemas,
  type SchemaDiffer,
} from './diff.js'
export { SchemaDiffError, type SchemaDiffErrorCode } from './errors.js'
export type {
  SchemaDiffAgainstDbOptions,
  SchemaDiffChange,
  SchemaDiffChangeKind,
  SchemaDiffOptions,
  SchemaDiffPath,
  SchemaDiffResult,
} from './types.js'
