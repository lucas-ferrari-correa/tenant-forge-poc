import type {
  InferredEntityTenancy,
  SchemaPushResult,
  TenancyMigrateResult,
} from '@tenant-forge/core'
import type { Engine } from './engine.js'

export type WriteFn = (text: string) => void

export type CliDeps = {
  engine: Engine
  out: WriteFn
  err: WriteFn
  env: NodeJS.ProcessEnv
  cwd: string
}

export function printLine(write: WriteFn, text = ''): void {
  write(`${text}\n`)
}

export function printJson(write: WriteFn, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`)
}

export function formatPushResult(result: SchemaPushResult): string {
  const lines = [`Applied schema to ${result.dialect}.`]
  if (result.created.length === 0) {
    lines.push('  (no objects created)')
  }
  for (const obj of result.created) {
    const ns = obj.namespace === undefined ? '' : `${obj.namespace}.`
    const model = obj.tenancyModel === undefined ? '' : ` [${obj.tenancyModel}]`
    lines.push(`  + ${obj.kind} ${ns}${obj.name}${model}`)
  }
  lines.push(...formatWarnings(result.warnings))
  return lines.join('\n')
}

export function formatInferredTenancy(inferred: readonly InferredEntityTenancy[]): string {
  const lines = ['Inferred tenancy:']
  if (inferred.length === 0) {
    lines.push('  (no entities)')
  }
  for (const entry of inferred) {
    const hint = entry.fromHint === true ? ' (from hint)' : ''
    lines.push(`  ${entry.entity}: ${entry.model}${hint}`)
  }
  return lines.join('\n')
}

export function formatMigrateResult(result: TenancyMigrateResult): string {
  const lines = [`Migrated tenancy on ${result.dialect}.`]
  lines.push('Steps:')
  if (result.steps.length === 0) {
    lines.push('  (no steps)')
  }
  for (const step of result.steps) {
    lines.push(`  ${step.entity}: ${step.from} -> ${step.to} (${step.action})`)
  }
  lines.push('Data moved:')
  if (result.migrated.length === 0) {
    lines.push('  (no rows moved)')
  }
  for (const row of result.migrated) {
    const scope = row.tenant === undefined ? 'global' : row.tenant
    const skipped = row.skipped === true ? ' (skipped)' : ''
    lines.push(`  ${row.entity}/${scope}: ${row.rows} rows${skipped}`)
  }
  lines.push(...formatWarnings(result.warnings))
  return lines.join('\n')
}

export function formatWarnings(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return []
  return ['Warnings:', ...warnings.map((w) => `  ! ${w}`)]
}
