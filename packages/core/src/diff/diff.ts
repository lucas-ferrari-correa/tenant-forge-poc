import type { FieldDefinition, RelationDefinition, SchemaAst } from '../ast/types.js'
import { assertValidSchema, SchemaValidationError } from '../ast/validate.js'
import { pullSchema } from '../pull/pull.js'
import type { SchemaPullTarget } from '../pull/types.js'
import {
  entityMetaEqual,
  fieldsEqual,
  indexByName,
  pushChange,
  relationsEqual,
  schemaTenancyEqual,
  servicesEqual,
  snapshotEntityMeta,
  snapshotField,
  snapshotRelation,
  snapshotSchemaTenancy,
  snapshotService,
} from './compare.js'
import { SchemaDiffError } from './errors.js'
import type {
  SchemaDiffAgainstDbOptions,
  SchemaDiffChange,
  SchemaDiffOptions,
  SchemaDiffResult,
} from './types.js'

function wrapValidation(ast: SchemaAst, label: string): void {
  try {
    assertValidSchema(ast)
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new SchemaDiffError(
        'SCHEMA_VALIDATION',
        `${label} schema failed validation: ${error.message}`,
      )
    }
    throw error
  }
}

function resolveOptions(options?: SchemaDiffOptions): {
  ignoreSchemaName: boolean
  ignoreServices: boolean
} {
  return {
    ignoreSchemaName: options?.ignoreSchemaName !== false,
    ignoreServices: options?.ignoreServices === true,
  }
}

function diffFields(
  entityName: string,
  localFields: readonly FieldDefinition[],
  remoteFields: readonly FieldDefinition[],
  changes: SchemaDiffChange[],
): void {
  const localMap = indexByName(localFields)
  const remoteMap = indexByName(remoteFields)
  const names = new Set([...localMap.keys(), ...remoteMap.keys()])

  for (const name of names) {
    const path = `entities.${entityName}.fields.${name}`
    const local = localMap.get(name)
    const remote = remoteMap.get(name)

    if (local !== undefined && remote === undefined) {
      pushChange(changes, { kind: 'localOnly', path, local: snapshotField(local) })
      continue
    }
    if (local === undefined && remote !== undefined) {
      pushChange(changes, { kind: 'remoteOnly', path, remote: snapshotField(remote) })
      continue
    }
    if (local !== undefined && remote !== undefined && !fieldsEqual(local, remote)) {
      pushChange(changes, {
        kind: 'mismatch',
        path,
        local: snapshotField(local),
        remote: snapshotField(remote),
      })
    }
  }
}

function diffRelations(
  entityName: string,
  localRelations: readonly RelationDefinition[] | undefined,
  remoteRelations: readonly RelationDefinition[] | undefined,
  changes: SchemaDiffChange[],
): void {
  const localMap = indexByName(localRelations ?? [])
  const remoteMap = indexByName(remoteRelations ?? [])
  const names = new Set([...localMap.keys(), ...remoteMap.keys()])

  for (const name of names) {
    const path = `entities.${entityName}.relations.${name}`
    const local = localMap.get(name)
    const remote = remoteMap.get(name)

    if (local !== undefined && remote === undefined) {
      pushChange(changes, { kind: 'localOnly', path, local: snapshotRelation(local) })
      continue
    }
    if (local === undefined && remote !== undefined) {
      pushChange(changes, { kind: 'remoteOnly', path, remote: snapshotRelation(remote) })
      continue
    }
    if (local !== undefined && remote !== undefined && !relationsEqual(local, remote)) {
      pushChange(changes, {
        kind: 'mismatch',
        path,
        local: snapshotRelation(local),
        remote: snapshotRelation(remote),
      })
    }
  }
}

function diffEntities(local: SchemaAst, remote: SchemaAst, changes: SchemaDiffChange[]): void {
  const localMap = indexByName(local.entities)
  const remoteMap = indexByName(remote.entities)
  const names = new Set([...localMap.keys(), ...remoteMap.keys()])

  for (const name of names) {
    const path = `entities.${name}`
    const localEntity = localMap.get(name)
    const remoteEntity = remoteMap.get(name)

    if (localEntity !== undefined && remoteEntity === undefined) {
      pushChange(changes, {
        kind: 'localOnly',
        path,
        local: snapshotEntityMeta(localEntity),
      })
      continue
    }
    if (localEntity === undefined && remoteEntity !== undefined) {
      pushChange(changes, {
        kind: 'remoteOnly',
        path,
        remote: snapshotEntityMeta(remoteEntity),
      })
      continue
    }
    if (localEntity === undefined || remoteEntity === undefined) {
      continue
    }

    if (!entityMetaEqual(localEntity, remoteEntity)) {
      pushChange(changes, {
        kind: 'mismatch',
        path: `${path}.tenancy`,
        local: snapshotEntityMeta(localEntity),
        remote: snapshotEntityMeta(remoteEntity),
      })
    }

    diffFields(name, localEntity.fields, remoteEntity.fields, changes)
    diffRelations(name, localEntity.relations, remoteEntity.relations, changes)
  }
}

function diffServices(local: SchemaAst, remote: SchemaAst, changes: SchemaDiffChange[]): void {
  const localMap = indexByName(local.services ?? [])
  const remoteMap = indexByName(remote.services ?? [])
  const names = new Set([...localMap.keys(), ...remoteMap.keys()])

  for (const name of names) {
    const path = `services.${name}`
    const localService = localMap.get(name)
    const remoteService = remoteMap.get(name)

    if (localService !== undefined && remoteService === undefined) {
      pushChange(changes, {
        kind: 'localOnly',
        path,
        local: snapshotService(localService),
      })
      continue
    }
    if (localService === undefined && remoteService !== undefined) {
      pushChange(changes, {
        kind: 'remoteOnly',
        path,
        remote: snapshotService(remoteService),
      })
      continue
    }
    if (
      localService !== undefined &&
      remoteService !== undefined &&
      !servicesEqual(localService, remoteService)
    ) {
      pushChange(changes, {
        kind: 'mismatch',
        path,
        local: snapshotService(localService),
        remote: snapshotService(remoteService),
      })
    }
  }
}

/**
 * Pure AST↔AST schema diff. `local` = repo expectation; `remote` = DB/introspected state.
 * Does not rename-detect entities (add/remove only).
 */
export function diffSchemas(
  local: SchemaAst,
  remote: SchemaAst,
  options?: SchemaDiffOptions,
): SchemaDiffResult {
  wrapValidation(local, 'local')
  wrapValidation(remote, 'remote')

  const { ignoreSchemaName, ignoreServices } = resolveOptions(options)
  const changes: SchemaDiffChange[] = []
  const warnings: string[] = []

  if (!ignoreSchemaName && local.name !== remote.name) {
    pushChange(changes, {
      kind: 'mismatch',
      path: 'schema.name',
      local: local.name,
      remote: remote.name,
    })
  }

  if (!schemaTenancyEqual(local.tenancy, remote.tenancy)) {
    pushChange(changes, {
      kind: 'mismatch',
      path: 'schema.tenancy',
      local: snapshotSchemaTenancy(local.tenancy),
      remote: snapshotSchemaTenancy(remote.tenancy),
    })
  }

  diffEntities(local, remote, changes)

  if (ignoreServices) {
    if ((local.services?.length ?? 0) > 0 || (remote.services?.length ?? 0) > 0) {
      warnings.push(
        'services comparison skipped (ignoreServices); pull does not introspect services',
      )
    }
  } else {
    diffServices(local, remote, changes)
  }

  return {
    equal: changes.length === 0,
    changes,
    warnings,
  }
}

export type SchemaDiffer = {
  diff(local: SchemaAst, options?: SchemaDiffAgainstDbOptions): Promise<SchemaDiffResult>
}

/**
 * Pull live DB into AST, then diff against `local`.
 * Includes `dialect` + `pull` on the result. Does not apply DDL.
 */
export async function diffSchemaAgainstDb(
  local: SchemaAst,
  target: SchemaPullTarget,
  options?: SchemaDiffAgainstDbOptions,
): Promise<SchemaDiffResult> {
  wrapValidation(local, 'local')

  const pulled = await pullSchema(target, options?.pull)
  const diffOptions: SchemaDiffOptions = {
    ignoreSchemaName: options?.ignoreSchemaName,
    // Pull never reconstructs services — skip by default against DB unless explicitly false.
    ignoreServices: options?.ignoreServices !== false,
  }

  const result = diffSchemas(local, pulled.ast, diffOptions)
  const warnings = [...pulled.warnings, ...result.warnings]

  if (target.dialect === 'mongodb') {
    const localHasRelations = local.entities.some((entity) => (entity.relations?.length ?? 0) > 0)
    const remoteHasRelations = pulled.ast.entities.some(
      (entity) => (entity.relations?.length ?? 0) > 0,
    )
    if (localHasRelations && !remoteHasRelations) {
      warnings.push(
        'MongoDB remote has no foreign-key constraints; relation diffs may be localOnly noise',
      )
    }
  }

  return {
    ...result,
    warnings,
    dialect: target.dialect,
    pull: pulled,
  }
}

/**
 * Bind a pull target once; diff repeatedly (e.g. CLI / SDK drift later).
 */
export function createSchemaDiffer(target: SchemaPullTarget): SchemaDiffer {
  return {
    diff(local: SchemaAst, options?: SchemaDiffAgainstDbOptions): Promise<SchemaDiffResult> {
      return diffSchemaAgainstDb(local, target, options)
    },
  }
}
