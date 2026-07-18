import { DslParseError, SchemaValidationError } from '@tenant-forge/core'

export const EXIT_OK = 0
export const EXIT_RUNTIME = 1
export const EXIT_USAGE = 2

/** Bad invocation: unknown command, missing/invalid flags. Maps to exit code 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

/** Usage/validation errors exit 2; engine/runtime failures exit 1. */
export function exitCodeForError(error: unknown): number {
  if (
    error instanceof CliUsageError ||
    error instanceof DslParseError ||
    error instanceof SchemaValidationError
  ) {
    return EXIT_USAGE
  }
  return EXIT_RUNTIME
}

export function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
