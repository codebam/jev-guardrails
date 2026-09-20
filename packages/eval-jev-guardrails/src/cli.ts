/**
 * `eval-jev` command line interface.
 *
 * Commands: `login` (GitHub device flow or `--token`),
 * `install opencode|hermes|dsh`, `buy`, `doctor`, `credits`.
 *
 * @module @codebam/eval-jev-guardrails/cli
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { EvalGuardrailsClient, normalizePromotionCode } from './client.js'
import { maskApiKey, resolveEvalConfig, writeEvalConfig } from './config.js'
import { runDoctor } from './doctor.js'
import type { DoctorHarness, DoctorScope } from './doctor.js'
import { installDsh } from './install/dsh.js'
import { installHermes } from './install/hermes.js'
import { installOpenCode } from './install/opencode.js'
import type { InstallResult } from './install/types.js'
import { EVAL_CREDIT_PACKS } from './types.js'
import type { EvalCreditPack } from './types.js'
import { PACKAGE_VERSION } from './version.js'

/** Host interface used by the CLI; injectable for tests. */
export interface CliIO {
  stdout: (message: string) => void
  stderr: (message: string) => void
  env: NodeJS.ProcessEnv
  cwd: string
  home: string
  /** Interactive prompt; defaults to a readline question on stdin/stdout. */
  prompt?: (question: string) => Promise<string | undefined>
  /** Injectable fetch for the device-flow login. */
  fetch?: typeof globalThis.fetch
  /** Injectable opener used by `buy --open`; defaults to the platform opener. */
  openExternal?: (url: string) => void
}

const INSTALL_HARNESSES = ['opencode', 'hermes', 'dsh'] as const
type InstallHarness = (typeof INSTALL_HARNESSES)[number]

const VALUE_FLAGS = new Set([
  'token',
  'promo',
  'base-url',
  'config',
  'profile',
  'dsh-home',
  'home',
  'dir',
  'timeout',
  'pack',
])

/** Run the CLI and return the process exit code. */
export async function runCli(argv: string[], overrides: Partial<CliIO> = {}): Promise<number> {
  const io: CliIO = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    ...overrides,
  }
  const parsed = parseArgs(argv)
  const command = parsed.positionals[0]

  if (parsed.booleans.has('version') || command === 'version') {
    io.stdout(`${PACKAGE_VERSION}\n`)
    return 0
  }
  if (parsed.booleans.has('help') || command === 'help' || command === undefined) {
    io.stdout(usage(command === 'help' ? parsed.positionals[1] : undefined))
    return command === undefined && argv.length > 0 ? 2 : 0
  }

  try {
    switch (command) {
      case 'login':
        return await commandLogin(parsed, io)
      case 'install':
        return commandInstall(parsed, io)
      case 'doctor':
        return await commandDoctor(parsed, io)
      case 'credits':
        return await commandCredits(parsed, io)
      case 'buy':
        return await commandBuy(parsed, io)
      default:
        io.stderr(`eval-jev: unknown command "${command}"\n\n${usage()}`)
        return 2
    }
  } catch (error) {
    io.stderr(`eval-jev: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function commandLogin(parsed: ParsedArgs, io: CliIO): Promise<number> {
  const env = io.env
  const configPath = flagString(parsed, 'config')
  const explicitToken = flagString(parsed, 'token')
  const explicitBase = flagString(parsed, 'base-url')
  const resolved = resolveEvalConfig({
    env,
    home: io.home,
    ...(configPath !== undefined ? { configPath } : {}),
    ...(explicitBase !== undefined ? { baseUrl: explicitBase } : {}),
  })

  let token = explicitToken
  if (token === undefined) {
    token = await deviceFlowLogin(resolved.baseUrl, io)
  }
  if (token === undefined) {
    token = await promptForToken(io)
  }
  if (token === undefined) {
    io.stderr(
      'eval-jev login: no token supplied and the GitHub device flow is unavailable on this server.\n' +
        'Pass `--token eval_...` (create one with the service, e.g. POST /admin/keys).\n',
    )
    return 1
  }
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    io.stderr('eval-jev login: the token is empty\n')
    return 1
  }
  const written = writeEvalConfig(
    { apiKey: trimmed, ...(explicitBase !== undefined ? { baseUrl: explicitBase } : {}) },
    { env, home: io.home, ...(configPath !== undefined ? { configPath } : {}) },
  )
  io.stdout(`Stored ${maskApiKey(trimmed)} in ${written} (mode 600)\n`)
  io.stdout(`Base URL: ${explicitBase ?? resolved.baseUrl}\n`)
  return 0
}

function commandInstall(parsed: ParsedArgs, io: CliIO): number {
  const harness = parsed.positionals[1]
  if (harness === undefined || !INSTALL_HARNESSES.includes(harness as InstallHarness)) {
    io.stderr(`eval-jev install: expected one of ${INSTALL_HARNESSES.join(', ')}\n\n${usage('install')}`)
    return 2
  }
  const globalScope = parsed.booleans.has('global')
  const projectScope = parsed.booleans.has('project')
  if (globalScope && projectScope) {
    io.stderr('eval-jev install: use either --global or --project, not both\n')
    return 2
  }
  const cwd = flagString(parsed, 'dir') ?? io.cwd
  const home = flagString(parsed, 'home') ?? io.home
  const env = io.env

  let result: InstallResult
  if (harness === 'dsh') {
    if (globalScope || projectScope) {
      io.stderr('eval-jev install dsh: dsh installs into a profile, not a project/global scope; use --profile\n')
      return 2
    }
    result = installDsh({
      env,
      home,
      ...(flagString(parsed, 'profile') !== undefined ? { profile: flagString(parsed, 'profile') as string } : {}),
      ...(flagString(parsed, 'dsh-home') !== undefined ? { dshHome: flagString(parsed, 'dsh-home') as string } : {}),
      installDependencies: !parsed.booleans.has('no-install'),
      ...(flagString(parsed, 'base-url') !== undefined ? { baseUrl: flagString(parsed, 'base-url') as string } : {}),
      ...(flagString(parsed, 'config') !== undefined ? { configPath: flagString(parsed, 'config') as string } : {}),
    })
  } else if (harness === 'opencode') {
    result = installOpenCode({ env, home, cwd, global: globalScope })
  } else {
    result = installHermes({ env, home, cwd, global: globalScope })
  }

  printInstallResult(result, io)
  return 0
}

async function commandDoctor(parsed: ParsedArgs, io: CliIO): Promise<number> {
  const harness = parsed.positionals[1]
  if (harness !== undefined && !['opencode', 'hermes', 'dsh'].includes(harness)) {
    io.stderr(`eval-jev doctor: expected opencode, hermes, or dsh (got "${harness}")\n`)
    return 2
  }
  const scope: DoctorScope | undefined = parsed.booleans.has('global') ? 'global' : parsed.booleans.has('project') ? 'project' : undefined
  const report = await runDoctor({
    env: io.env,
    cwd: flagString(parsed, 'dir') ?? io.cwd,
    home: flagString(parsed, 'home') ?? io.home,
    ...(harness !== undefined ? { harness: harness as DoctorHarness } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(flagString(parsed, 'config') !== undefined ? { configPath: flagString(parsed, 'config') as string } : {}),
    ...(flagString(parsed, 'profile') !== undefined ? { profile: flagString(parsed, 'profile') as string } : {}),
    ...(flagString(parsed, 'dsh-home') !== undefined ? { dshHome: flagString(parsed, 'dsh-home') as string } : {}),
    checkService: !parsed.booleans.has('offline'),
  })

  if (parsed.booleans.has('json')) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    io.stdout(`eval-jev doctor (${report.harness})\n`)
    io.stdout(`  config: ${report.config.configPath}\n`)
    io.stdout(`  base URL: ${report.config.baseUrl} (${report.config.baseUrlSource})\n`)
    io.stdout(`  api key: ${report.config.maskedApiKey} (${report.config.apiKeySource})\n`)
    for (const check of report.checks) {
      io.stdout(`  [${check.status}] ${check.name}: ${check.detail}\n`)
    }
  }
  return report.ok ? 0 : 1
}

async function commandCredits(parsed: ParsedArgs, io: CliIO): Promise<number> {
  const env = io.env
  const client = new EvalGuardrailsClient({
    env,
    home: flagString(parsed, 'home') ?? io.home,
    ...(flagString(parsed, 'config') !== undefined ? { configPath: flagString(parsed, 'config') as string } : {}),
    ...(flagString(parsed, 'base-url') !== undefined ? { baseUrl: flagString(parsed, 'base-url') as string } : {}),
  })
  const credits = await client.credits()
  if (parsed.booleans.has('json')) {
    io.stdout(`${JSON.stringify(credits, null, 2)}\n`)
  } else {
    const remaining = credits.remaining
    io.stdout(`Remaining credits: ${String(remaining)}\n`)
    if (typeof credits.charged === 'number') io.stdout(`Last charge: ${credits.charged}\n`)
  }
  return 0
}

/** `eval-jev buy [--pack p5000|...] [--open] [--json]`. */
async function commandBuy(parsed: ParsedArgs, io: CliIO): Promise<number> {
  const pack = flagString(parsed, 'pack')
  if (pack === undefined || !EVAL_CREDIT_PACKS.includes(pack as EvalCreditPack)) {
    io.stderr(
      `eval-jev buy: --pack must be one of ${EVAL_CREDIT_PACKS.join(', ')}` +
        `${pack !== undefined ? ` (got "${pack}")` : ''}\n\n${usage('buy')}`,
    )
    return 2
  }

  const promoFlag = flagString(parsed, 'promo')
  let promotionCode: string | undefined
  if (promoFlag !== undefined) {
    try {
      promotionCode = normalizePromotionCode(promoFlag)
    } catch (error) {
      io.stderr(`eval-jev buy: ${error instanceof Error ? error.message : String(error)}

${usage('buy')}`)
      return 2
    }
  }

  const client = new EvalGuardrailsClient({
    env: io.env,
    home: flagString(parsed, 'home') ?? io.home,
    ...(flagString(parsed, 'config') !== undefined ? { configPath: flagString(parsed, 'config') as string } : {}),
    ...(flagString(parsed, 'base-url') !== undefined ? { baseUrl: flagString(parsed, 'base-url') as string } : {}),
  })
  const checkout = await client.checkout(pack as EvalCreditPack, promotionCode !== undefined ? { promotionCode } : {})

  if (parsed.booleans.has('json')) {
    io.stdout(`${JSON.stringify(checkout, null, 2)}\n`)
  } else {
    io.stdout(`Stripe Checkout URL: ${checkout.url}\n`)
    if (typeof checkout.id === 'string' && checkout.id.length > 0) {
      io.stdout(`Checkout session: ${checkout.id}\n`)
    }
  }
  if (parsed.booleans.has('open')) {
    const open = io.openExternal ?? ((url: string) => openExternalUrl(url, (message) => io.stderr(`${message}\n`)))
    open(checkout.url)
  }
  return 0
}

/**
 * Best-effort platform opener used by `buy --open`.
 *
 * Never throws: a missing opener only produces an `onError` message, because
 * the printed checkout URL is still enough to complete the purchase.
 */
export function openExternalUrl(url: string, onError?: (message: string) => void): void {
  const platform = process.platform
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', (error) => onError?.(`could not open ${url}: ${error.message}`))
    child.unref()
  } catch (error) {
    onError?.(`could not open ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** GitHub-device-style login. Returns undefined when the server has no device flow. */
async function deviceFlowLogin(baseUrl: string, io: CliIO): Promise<string | undefined> {
  const fetchImpl = io.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return undefined
  let device: Record<string, unknown>
  try {
    const response = await fetchImpl(`${baseUrl}/v1/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ scope: 'read:user user:email' }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const parsed = (await response.json()) as unknown
    if (parsed === null || typeof parsed !== 'object') return undefined
    device = parsed as Record<string, unknown>
  } catch {
    return undefined
  }
  const deviceCode = stringValue(device.device_code)
  const userCode = stringValue(device.user_code)
  const verificationUri = stringValue(device.verification_uri) ?? stringValue(device.verification_url)
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) return undefined

  io.stdout(`Open ${verificationUri}${stringValue(device.verification_uri_complete) !== undefined ? ` or ${String(device.verification_uri_complete)}` : ''}\n`)
  io.stdout(`Enter code: ${userCode}\n`)
  const intervalMs = normalizeSeconds(device.interval, 5) * 1000
  const expiresAt = Date.now() + normalizeSeconds(device.expires_in, 600) * 1000
  let firstPoll = true
  while (Date.now() < expiresAt) {
    if (firstPoll) firstPoll = false
    else await sleep(intervalMs)
    try {
      const response = await fetchImpl(`${baseUrl}/v1/auth/device/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        signal: AbortSignal.timeout(10_000),
      })
      const parsed = (await response.json()) as Record<string, unknown>
      if (response.ok) {
        const token = stringValue(parsed.apiKey) ?? stringValue(parsed.access_token)
        if (token !== undefined) return token
      }
      const error = stringValue(parsed.error)
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') {
        await sleep(intervalMs)
        continue
      }
      if (error !== undefined && error !== 'authorization_pending') return undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Basic interactive fallback used by tests and terminals without device flow. */
export async function promptForToken(io: CliIO): Promise<string | undefined> {
  if (io.prompt !== undefined) {
    const answer = await io.prompt('Paste eval_ API token: ')
    return answer?.trim() || undefined
  }
  if (process.stdin.isTTY !== true) return undefined
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('Paste eval_ API token: ')
    return answer.trim() || undefined
  } finally {
    rl.close()
  }
}

function printInstallResult(result: InstallResult, io: CliIO): void {
  io.stdout(`eval-jev install ${result.harness} (${result.scope})\n`)
  io.stdout(`  target: ${result.target}\n`)
  for (const file of result.files) {
    io.stdout(`  ${file.status.padEnd(9)} ${file.path}\n`)
  }
  for (const warning of result.warnings) io.stderr(`  warning: ${warning}\n`)
  for (const note of result.notes) io.stdout(`  note: ${note}\n`)
  io.stdout(result.changed ? '  install updated files\n' : '  install already up to date\n')
}

interface ParsedArgs {
  positionals: string[]
  values: Map<string, string>
  booleans: Set<string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const values = new Map<string, string>()
  const booleans = new Set<string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? ''
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      const name = equals >= 0 ? token.slice(2, equals) : token.slice(2)
      if (name.length === 0) continue
      if (equals >= 0) {
        values.set(name, token.slice(equals + 1))
        continue
      }
      const next = argv[index + 1]
      if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith('-')) {
        values.set(name, next)
        index += 1
      } else {
        booleans.add(name)
      }
      continue
    }
    if (token === '-h') {
      booleans.add('help')
      continue
    }
    if (token === '-v') {
      booleans.add('version')
      continue
    }
    if (token.startsWith('-')) {
      booleans.add(token.replace(/^-+/, ''))
      continue
    }
    positionals.push(token)
  }
  return { positionals, values, booleans }
}

function flagString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.values.get(name)
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeSeconds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function usage(command?: string): string {
  if (command === 'install') {
    return `eval-jev install <opencode|hermes|dsh> [options]

  opencode --project (default) | --global   install the tool.execute.before hook
  hermes   --project (default) | --global   install the pre_tool_call plugin
  dsh      --profile <name> [--dsh-home] [--no-install]
                                           select the hosted bundle in that profile

  common: --dir <project root> --home <home dir> --base-url <url> --config <path>
`
  }
  if (command === 'doctor') {
    return `eval-jev doctor [opencode|hermes|dsh] [--project|--global] [--offline] [--json]
`
  }
  if (command === 'login') {
    return `eval-jev login [--token eval_...] [--base-url <url>] [--config <path>]

Without --token, starts the service's GitHub device flow. --token remains
supported for CI and for servers where the device flow is unavailable.
`
  }
  if (command === 'buy') {
    return `eval-jev buy --pack <${EVAL_CREDIT_PACKS.join('|')}> [--promo <code>] [--open] [--json]

Packs: p5000 = 5,000 credits, p25000 = 25,000, p100000 = 100,000,
p500000 = 500,000. Creates a Stripe Checkout Session and prints its URL.
--promo pre-applies a Stripe promotion code; Stripe Checkout also accepts
codes interactively by default. --open launches the platform browser opener.
`
  }
  return `eval-jev ${PACKAGE_VERSION} — hosted eval.seanbehan.ca guardrails

Usage:
  eval-jev login [--token eval_...] [--base-url <url>] [--config <path>]
  eval-jev install opencode [--project|--global]
  eval-jev install hermes   [--project|--global]
  eval-jev install dsh      [--profile <name>] [--dsh-home <path>] [--no-install]
  eval-jev buy --pack <${EVAL_CREDIT_PACKS.join('|')}> [--promo <code>] [--open] [--json]
  eval-jev doctor [opencode|hermes|dsh] [--project|--global] [--offline] [--json]
  eval-jev credits [--json]
  eval-jev version

login without --token uses the GitHub device flow; --token still works.
Config: EVAL_API_KEY / EVAL_BASE_URL, then ~/.config/eval-jev/config.json.
`
}
