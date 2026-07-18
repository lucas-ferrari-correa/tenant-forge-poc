#!/usr/bin/env node
import { realEngine } from './engine.js'
import { run } from './run.js'

run(process.argv.slice(2), {
  engine: realEngine,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
}).then((code) => {
  process.exitCode = code
})

export { type Engine, realEngine } from './engine.js'
export type { CliDeps } from './output.js'
export { run } from './run.js'
