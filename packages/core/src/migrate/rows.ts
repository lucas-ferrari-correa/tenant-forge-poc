import { TENANT_ID_FIELD_NAME } from '../ast/tenancy.js'
import type { EntityDefinition } from '../ast/types.js'

/** Field names to read from a source table/collection for a migrate step. */
export function sourceFieldNames(entity: EntityDefinition): string[] {
  return entity.fields.map((field) => field.name)
}

/** Field names expected on the destination (may differ by tenant_id). */
export function destinationFieldNames(entity: EntityDefinition): string[] {
  return entity.fields.map((field) => field.name)
}

/**
 * Project a source row onto destination columns.
 * When `injectTenantId` is set, writes that value into the tenant_id column.
 */
export function projectRow(
  row: Record<string, unknown>,
  destFields: readonly string[],
  injectTenantId?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of destFields) {
    if (name === TENANT_ID_FIELD_NAME && injectTenantId !== undefined) {
      out[name] = injectTenantId
      continue
    }
    if (Object.hasOwn(row, name)) {
      out[name] = row[name]
    }
  }
  return out
}
