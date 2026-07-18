import { readFileSync } from 'node:fs'
import { CliUsageError } from './errors.js'

export function readSchema(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new CliUsageError(`cannot read schema at ${path}`)
  }
}
