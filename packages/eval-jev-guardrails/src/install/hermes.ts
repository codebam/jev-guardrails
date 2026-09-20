/**
 * Idempotent Hermes Agent installer.
 *
 * Copies `templates/hermes/eval-jev-guardrails/` into
 * `~/.hermes/plugins/` (global) or `<cwd>/.hermes/plugins/` (project) and
 * enables the plugin with `hermes plugins enable eval-jev-guardrails` when
 * the binary is on PATH.
 *
 * @module @codebam/eval-jev-guardrails/install/hermes
 */
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_VERSION } from '../version.js'
import type { InstallResult } from './types.js'
import { copyTemplateFile, findOnPath, templateFiles } from './util.js'

const PLUGIN_NAME = 'eval-jev-guardrails'
const templateDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../templates/hermes', PLUGIN_NAME)

/** Options for {@link installHermes}. */
export interface InstallHermesOptions {
  /** `global` targets `$HERMES_HOME/plugins`; default is project scope. */
  global?: boolean
  /** Project root for project scope; defaults to `process.cwd()`. */
  cwd?: string
  /** Home directory for global scope; defaults to `os.homedir()`. */
  home?: string
  env?: NodeJS.ProcessEnv
  /** Run `hermes plugins enable` when the binary is on PATH. Default: true. */
  enable?: boolean
  /** Injectable spawnSync (tests). */
  spawn?: typeof spawnSync
}

/** Directory the Hermes plugin is copied into. */
export function hermesPluginsDir(options: InstallHermesOptions = {}): string {
  const env = options.env ?? process.env
  if (options.global === true) {
    const hermesHome = env.HERMES_HOME?.trim()
    const home = hermesHome !== undefined && hermesHome.length > 0 ? hermesHome : join(options.home ?? homedir(), '.hermes')
    return join(home, 'plugins')
  }
  return join(options.cwd ?? process.cwd(), '.hermes', 'plugins')
}

/** Bundled Hermes template directory inside this package. */
export function hermesTemplateDir(): string {
  return templateDir
}

/** Install the real `pre_tool_call` Hermes plugin. */
export function installHermes(options: InstallHermesOptions = {}): InstallResult {
  const env = options.env ?? process.env
  const scope = options.global === true ? 'global' : 'project'
  const pluginsDir = hermesPluginsDir(options)
  const targetDir = join(pluginsDir, PLUGIN_NAME)
  const sources = templateFiles(templateDir)
  if (sources.length === 0) {
    throw new Error(`the bundled Hermes template is empty: ${templateDir}`)
  }
  const files = sources.map((name) =>
    copyTemplateFile(join(templateDir, name), join(targetDir, name), (content) =>
      name === 'plugin.yaml' ? content.replace(/^version:.*$/m, `version: ${PACKAGE_VERSION}`) : content,
    ),
  )

  const warnings: string[] = []
  const notes: string[] = []
  if (options.enable !== false) {
    const hermesBin = findOnPath('hermes', env)
    if (hermesBin === undefined) {
      notes.push('`hermes` is not on PATH; run `hermes plugins enable eval-jev-guardrails` yourself to activate the plugin.')
    } else {
      const spawn = options.spawn ?? spawnSync
      const spawnEnv = { ...env }
      if (options.home !== undefined) spawnEnv.HOME = options.home
      const result = spawn(hermesBin, ['plugins', 'enable', PLUGIN_NAME], {
        env: spawnEnv,
        encoding: 'utf8',
        timeout: 30_000,
      })
      if (result.error !== undefined) {
        warnings.push(`could not run \`hermes plugins enable ${PLUGIN_NAME}\`: ${result.error.message}`)
      } else if (result.status !== 0) {
        const detail = (result.stderr ?? result.stdout ?? '').trim()
        warnings.push(
          `\`hermes plugins enable ${PLUGIN_NAME}\` exited with status ${String(result.status)}${detail.length > 0 ? `: ${detail}` : ''}`,
        )
      } else {
        notes.push(`Enabled with \`hermes plugins enable ${PLUGIN_NAME}\`.`)
      }
    }
  }

  if (scope === 'project') {
    notes.push('Project plugins need HERMES_ENABLE_PROJECT_PLUGINS=1 when Hermes starts.')
  }
  notes.push('The callback calls POST /v1/evaluate before every tool call; EVAL_REVIEW_MODE=allow lets review verdicts run.')
  notes.push('EVAL_FAIL_MODE=open|review|closed controls service failures; EVAL_API_KEY comes from the environment or ~/.config/eval-jev/config.json.')

  return {
    harness: 'hermes',
    scope,
    target: pluginsDir,
    changed: files.some((file) => file.status !== 'unchanged'),
    files,
    warnings,
    notes,
  }
}
