#!/usr/bin/env node
/** `eval-jev` executable shim. @module @codebam/eval-jev-guardrails/bin */
import { runCli } from './cli.js'

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`eval-jev: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
