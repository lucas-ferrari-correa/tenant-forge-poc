import { type ParsedArgs, parseCliArgs } from './args.js'
import { runDbPull } from './commands/db-pull.js'
import { runDbPush } from './commands/db-push.js'
import { runGenerate } from './commands/generate.js'
import { runInit } from './commands/init.js'
import { runTenancyMigrate } from './commands/tenancy-migrate.js'
import { runValidate } from './commands/validate.js'
import { CliUsageError, EXIT_OK, exitCodeForError, messageForError } from './errors.js'
import { HELP_TEXT } from './help.js'
import { type CliDeps, printLine } from './output.js'

export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseCliArgs(argv)
  } catch (error) {
    printLine(deps.err, messageForError(error))
    return exitCodeForError(error)
  }

  const [first, second] = args.positionals
  if (args.values.help === true || first === undefined || first === 'help') {
    deps.out(HELP_TEXT)
    return EXIT_OK
  }

  try {
    await dispatch(first, second, deps, args)
    return EXIT_OK
  } catch (error) {
    printLine(deps.err, messageForError(error))
    return exitCodeForError(error)
  }
}

async function dispatch(
  first: string,
  second: string | undefined,
  deps: CliDeps,
  args: ParsedArgs,
): Promise<void> {
  switch (first) {
    case 'init':
      return runInit(deps, args)
    case 'validate':
      return runValidate(deps, args)
    case 'generate':
      return runGenerate(deps, args)
    case 'db':
      return dispatchDb(second, deps, args)
    case 'tenancy':
      return dispatchTenancy(second, deps, args)
    default:
      throw new CliUsageError(`unknown command "${first}"; run "tenant-forge help"`)
  }
}

function dispatchDb(sub: string | undefined, deps: CliDeps, args: ParsedArgs): Promise<void> {
  switch (sub) {
    case 'push':
      return runDbPush(deps, args)
    case 'pull':
      return runDbPull(deps, args)
    default:
      throw new CliUsageError('db requires a subcommand: push | pull')
  }
}

function dispatchTenancy(sub: string | undefined, deps: CliDeps, args: ParsedArgs): Promise<void> {
  if (sub === 'migrate') {
    return runTenancyMigrate(deps, args)
  }
  throw new CliUsageError('tenancy requires a subcommand: migrate')
}
