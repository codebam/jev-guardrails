/**
 * `eval-jev doctor`: verify config, service reachability, and each harness
 * installation without running the harness itself.
 *
 * @module @codebam/eval-jev-guardrails/doctor
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EvalGuardrailsClient } from './client.js'
import { maskApiKey, resolveEvalConfig } from './config.js'
import { hermesPluginsDir } from './install/hermes.js'
import { openCodeConfigDir } from './install/opencode.js'
import { resolveDshProfile } from './install/dsh.js'
import { EVAL_CREDIT_PACKS } from './types.js'
import type { EvalCreditsResponse, EvalResolvedConfig } from './types.js'

/** Credit balance below which `doctor` suggests `eval-jev buy`. */
export const LOW_CREDIT_THRESHOLD = 50

/** Harnesses `doctor` understands. */
export type DoctorHarness = 'opencode' | 'hermes' | 'dsh'

/** Install scope to inspect. */
export type DoctorScope = 'project' | 'global'

/** Options for {@link runDoctor}. */
export interface DoctorOptions {
  harness?: DoctorHarness
  scope?: DoctorScope
  cwd?: string
  home?: string
  env?: NodeJS.ProcessEnv
  /** Set false to skip the network check. Default: true. */
  checkService?: boolean
  apiKey?: string
  baseUrl?: string
  configPath?: string
  dshHome?: string
  profile?: string
  /** Injectable client (tests). */
  client?: EvalGuardrailsClient
}

/** One check in the report. */
export interface DoctorCheck {
  name: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
}

/** Full doctor report. */
export interface DoctorReport {
  ok: boolean
  harness: DoctorHarness | 'all'
  config: {
    configPath: string
    baseUrl: string
    baseUrlSource: EvalResolvedConfig['baseUrlSource']
    apiKey: string | undefined
    maskedApiKey: string
    apiKeySource: EvalResolvedConfig['apiKeySource']
  }
  checks: DoctorCheck[]
}

/** Run the doctor. Never throws for a missing key or unreachable service. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const resolved = resolveEvalConfig({
    env,
    home,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  })
  const checks: DoctorCheck[] = []

  if (resolved.apiKey === undefined) {
    checks.push({
      name: 'api key',
      status: 'fail',
      detail: `no key found in EVAL_API_KEY or ${resolved.configPath}; run \`eval-jev login\` (GitHub device flow) or pass --token`,
    })
  } else {
    checks.push({
      name: 'api key',
      status: 'ok',
      detail: `${maskApiKey(resolved.apiKey)} (source: ${resolved.apiKeySource})`,
    })
  }

  if (resolved.apiKey !== undefined && options.checkService !== false) {
    const client =
      options.client ??
      new EvalGuardrailsClient({
        env,
        home,
        ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
        ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      })
    try {
      const credits = await client.credits()
      const remaining = creditNumber(credits.remaining)
      const buyNote =
        remaining !== undefined && remaining < LOW_CREDIT_THRESHOLD
          ? `; low balance — run \`eval-jev buy --pack ${EVAL_CREDIT_PACKS[0]}\` to add credits`
          : ''
      checks.push({
        name: 'service',
        status: 'ok',
        detail: `${resolved.baseUrl} reachable; ${describeCredits(credits)}${buyNote}`,
      })
    } catch (error) {
      checks.push({
        name: 'service',
        status: 'fail',
        detail: `${resolved.baseUrl} unreachable: ${errorMessage(error)}`,
      })
    }
  } else if (resolved.apiKey !== undefined) {
    checks.push({ name: 'service', status: 'warn', detail: 'not checked (--offline)' })
  }

  const harnesses: DoctorHarness[] = options.harness !== undefined ? [options.harness] : ['opencode', 'hermes', 'dsh']
  for (const harness of harnesses) {
    const required = options.harness !== undefined
    if (harness === 'opencode') checks.push(checkOpenCode(options, required))
    if (harness === 'hermes') checks.push(checkHermes(options, required))
    if (harness === 'dsh') checks.push(checkDsh(options, required))
  }

  return {
    ok: checks.every((check) => check.status !== 'fail'),
    harness: options.harness ?? 'all',
    config: {
      configPath: resolved.configPath,
      baseUrl: resolved.baseUrl,
      baseUrlSource: resolved.baseUrlSource,
      apiKey: resolved.apiKey,
      maskedApiKey: maskApiKey(resolved.apiKey),
      apiKeySource: resolved.apiKeySource,
    },
    checks,
  }
}

function checkOpenCode(options: DoctorOptions, required: boolean): DoctorCheck {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const scopes: Array<DoctorScope> = options.scope !== undefined ? [options.scope] : ['project', 'global']
  const found: string[] = []
  const missing: string[] = []
  for (const scope of scopes) {
    const dir = openCodeConfigDir({ global: scope === 'global', cwd, home, env })
    const plugin = join(dir, 'plugins', 'eval-jev-guardrails.js')
    const pkg = join(dir, 'package.json')
    const hasPlugin = existsSync(plugin)
    const hasDependency = readJson(pkg)?.dependencies !== undefined &&
      typeof (readJson(pkg)?.dependencies as Record<string, unknown> | undefined)?.['@codebam/eval-jev-guardrails'] === 'string'
    if (hasPlugin && hasDependency) found.push(`${scope}: ${plugin}`)
    else missing.push(`${scope}: ${plugin}${hasDependency ? '' : ' (package.json dependency missing)'}`)
  }
  if (found.length > 0) {
    return { name: 'opencode hook', status: 'ok', detail: found.join('; ') }
  }
  return {
    name: 'opencode hook',
    status: required ? 'fail' : 'warn',
    detail: `not installed (${missing.join('; ')}); run \`eval-jev install opencode\``,
  }
}

function checkHermes(options: DoctorOptions, required: boolean): DoctorCheck {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const scopes: Array<DoctorScope> = options.scope !== undefined ? [options.scope] : ['project', 'global']
  const found: string[] = []
  const missing: string[] = []
  let projectFound = false
  for (const scope of scopes) {
    const pluginsDir = hermesPluginsDir({ global: scope === 'global', cwd, home, env })
    const pluginDir = join(pluginsDir, 'eval-jev-guardrails')
    const manifest = join(pluginDir, 'plugin.yaml')
    const init = join(pluginDir, '__init__.py')
    if (existsSync(manifest) && existsSync(init)) {
      found.push(`${scope}: ${pluginDir}`)
      if (scope === 'project') projectFound = true
    } else {
      missing.push(`${scope}: ${pluginDir}`)
    }
  }
  if (found.length > 0) {
    return {
      name: 'hermes hook',
      status: 'ok',
      detail: `${found.join('; ')}${
        projectFound || options.scope === 'project' ? ' (project plugins also need HERMES_ENABLE_PROJECT_PLUGINS=1)' : ''
      }`,
    }
  }
  return {
    name: 'hermes hook',
    status: required ? 'fail' : 'warn',
    detail: `not installed (${missing.join('; ')}); run \`eval-jev install hermes\``,
  }
}

function checkDsh(options: DoctorOptions, required: boolean): DoctorCheck {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  let profileInfo
  try {
    profileInfo = resolveDshProfile({
      env,
      home,
      ...(options.dshHome !== undefined ? { dshHome: options.dshHome } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
    })
  } catch (error) {
    return {
      name: 'dsh bundle',
      status: required ? 'fail' : 'warn',
      detail: errorMessage(error),
    }
  }

  const manifestPath = join(profileInfo.profileDir, 'package.json')
  const patchPath = join(profileInfo.profileDir, 'cordis.patch.yml')
  const manifest = readJson(manifestPath)
  const dependencies = manifest?.dependencies
  const hasDependency =
    dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies) &&
    typeof (dependencies as Record<string, unknown>)['@codebam/dsh-jev-guardrails'] === 'string'
  const profileSection =
    manifest?.dsh !== null && typeof manifest?.dsh === 'object' && !Array.isArray(manifest.dsh)
      ? (manifest.dsh as Record<string, unknown>).profile
      : undefined
  const bundles = profileSection !== null && typeof profileSection === 'object' ? (profileSection as Record<string, unknown>).bundles : undefined
  const hasBundle = Array.isArray(bundles) && bundles.includes('@codebam/dsh-jev-guardrails')
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const hasHostedRow = patch.includes('id: jev-guardrails') && patch.includes('provider: hosted') && patch.includes('process.env.EVAL_API_KEY')
  const missing: string[] = []
  if (!hasDependency) missing.push('profile dependency')
  if (!hasBundle) missing.push('dsh.profile.bundles')
  if (!hasHostedRow) missing.push('provider: hosted patch row')

  if (missing.length === 0) {
    return {
      name: 'dsh bundle',
      status: 'ok',
      detail: `${profileInfo.profileDir} selects @codebam/dsh-jev-guardrails (provider hosted)`,
    }
  }
  return {
    name: 'dsh bundle',
    status: required ? 'fail' : 'warn',
    detail: `profile "${profileInfo.profile}" is missing ${missing.join(', ')}; run \`eval-jev install dsh --profile ${profileInfo.profile}\``,
  }
}

function describeCredits(credits: EvalCreditsResponse): string {
  const remaining = creditNumber(credits.remaining)
  const charged = creditNumber(credits.charged)
  const total = creditNumber(credits.total)
  const parts = [`remaining ${remaining ?? 'unknown'}`]
  if (charged !== undefined) parts.push(`charged ${charged}`)
  if (total !== undefined) parts.push(`total ${total}`)
  return `credits ${parts.join(', ')}`
}

function creditNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
