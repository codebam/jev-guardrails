/**
 * Idempotent DeepSeek Harness installer.
 *
 * Selects `@codebam/dsh-jev-guardrails` as a profile bundle and adds a
 * profile-level `cordis.patch.yml` row that overrides the bundle's
 * `jev-guardrails` row to `provider: hosted` with the eval.seanbehan.ca base
 * URL and a `!!js process.env.EVAL_API_KEY` key reference. No secret is
 * written to disk.
 *
 * @module @codebam/eval-jev-guardrails/install/dsh
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveEvalConfig } from '../config.js'
import { DSH_GUARDRAILS_RANGE } from '../version.js'
import type { FileChange, InstallResult } from './types.js'
import { InstallError } from './types.js'
import { updateJsonFile, upsertTopLevelYamlItem, writeTextIfChanged, yamlScalar } from './util.js'

const BUNDLE_NAME = '@codebam/dsh-jev-guardrails'
const ROW_ID = 'jev-guardrails'
const PATCH_HEADER = `# Profile patch layer for this dsh profile, applied after every bundle layer.
# Managed by \`eval-jev install dsh\`: the jev-guardrails row below selects the
# hosted eval.seanbehan.ca provider. Other rows are left untouched.
`

/** Result of running the profile package manager. */
export interface PackageManagerResult {
  ok: boolean
  command: string
  output?: string
}

/** Options for {@link installDsh}. */
export interface InstallDshOptions {
  /** Profile name; otherwise `DSH_PROFILE`, then the only profile, then `default`. */
  profile?: string
  /** DSH_HOME; otherwise `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Home directory used for `~/.dsh` and the eval config file. */
  home?: string
  env?: NodeJS.ProcessEnv
  /** Base URL to write into the profile patch; otherwise resolved from env/config. */
  baseUrl?: string
  /** Explicit API key, only used to detect that a key exists (never written). */
  apiKey?: string
  /** Config file override used while resolving the base URL/key. */
  configPath?: string
  /**
   * Run the profile package manager to install the bundle dependency.
   * Default: true. The install is skipped when the package already exists in
   * `node_modules`. Set to false for hermetic tests or offline installs.
   */
  installDependencies?: boolean
  /** Override the package-manager runner (tests/embedding). */
  runPackageManager?: (profileDir: string) => PackageManagerResult
}

/** Resolve the dsh home directory. */
export function resolveDshHome(options: InstallDshOptions = {}): string {
  const env = options.env ?? process.env
  const explicit = options.dshHome?.trim()
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(options.home ?? homedir(), '.dsh')
}

/** List profile directories that contain a package.json. */
export function listDshProfiles(dshHome: string): string[] {
  const profilesDir = join(dshHome, 'profiles')
  if (!existsSync(profilesDir)) return []
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(profilesDir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort()
}

/** Pick the profile to install into, with actionable errors. */
export function resolveDshProfile(options: InstallDshOptions = {}): { dshHome: string; profile: string; profileDir: string } {
  const env = options.env ?? process.env
  const dshHome = resolveDshHome(options)
  const profiles = listDshProfiles(dshHome)
  const requested = options.profile?.trim() ?? env.DSH_PROFILE?.trim()

  let profile: string | undefined = requested !== undefined && requested.length > 0 ? requested : undefined
  if (profile !== undefined && !profiles.includes(profile)) {
    throw new InstallError(
      `dsh profile "${profile}" was not found under ${join(dshHome, 'profiles')}. ` +
        `Run \`dsh --profile ${profile}\` once to initialize it, or pass --dsh-home/--profile.`,
    )
  }
  if (profile === undefined) {
    if (profiles.includes('default')) profile = 'default'
    else if (profiles.length === 1) profile = profiles[0]
  }
  if (profile === undefined) {
    const available = profiles.length > 0 ? profiles.map((name) => `"${name}"`).join(', ') : '(none found)'
    throw new InstallError(
      `choose a dsh profile with --profile <name> (available: ${available}); ` +
        `DSH_HOME is ${dshHome}. Run \`dsh --profile <name>\` once if the profile does not exist yet.`,
    )
  }
  return { dshHome, profile, profileDir: join(dshHome, 'profiles', profile) }
}

/** Render the profile cordis.patch.yml row for the hosted provider. */
export function renderDshPatchRow(baseUrl: string): string[] {
  return [
    `- id: ${ROW_ID}`,
    `  name: '${BUNDLE_NAME}'`,
    '  config:',
    '    provider: hosted',
    `    baseURL: ${yamlScalar(baseUrl)}`,
    '    apiKey: !!js process.env.EVAL_API_KEY',
    '    actions: enforce',
  ]
}

/** Install / select the dsh bundle for one profile. */
export function installDsh(options: InstallDshOptions = {}): InstallResult {
  const env = options.env ?? process.env
  const { dshHome, profile, profileDir } = resolveDshProfile(options)
  const manifestPath = join(profileDir, 'package.json')
  const patchPath = join(profileDir, 'cordis.patch.yml')

  const resolved = resolveEvalConfig({
    env,
    ...(options.home !== undefined ? { home: options.home } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  })

  const manifestChange = updateJsonFile(manifestPath, (current) => {
    const next = { ...current }
    const dependencies =
      current.dependencies !== null && typeof current.dependencies === 'object' && !Array.isArray(current.dependencies)
        ? { ...(current.dependencies as Record<string, unknown>) }
        : {}
    const existing = dependencies[BUNDLE_NAME]
    if (typeof existing !== 'string' || shouldReplaceSpec(existing)) {
      dependencies[BUNDLE_NAME] = DSH_GUARDRAILS_RANGE
    }
    next.dependencies = dependencies
    const dsh = current.dsh !== null && typeof current.dsh === 'object' && !Array.isArray(current.dsh) ? { ...(current.dsh as Record<string, unknown>) } : {}
    const dshProfile =
      dsh.profile !== null && typeof dsh.profile === 'object' && !Array.isArray(dsh.profile)
        ? { ...(dsh.profile as Record<string, unknown>) }
        : {}
    const bundles = Array.isArray(dshProfile.bundles) ? [...(dshProfile.bundles as unknown[])] : []
    if (!bundles.includes(BUNDLE_NAME)) bundles.push(BUNDLE_NAME)
    dshProfile.bundles = bundles
    dsh.profile = dshProfile
    next.dsh = dsh
    return next
  })

  const patchChange = upsertPatchFile(patchPath, resolved.baseUrl)

  const warnings: string[] = []
  const notes: string[] = [
    `Selected ${BUNDLE_NAME}@${DSH_GUARDRAILS_RANGE} as a bundle for dsh profile "${profile}".`,
    'The profile patch sets provider: hosted, baseURL, apiKey: !!js process.env.EVAL_API_KEY, and actions: enforce.',
    'Export EVAL_API_KEY in the environment that launches dsh; the profile never stores the key.',
    `Verify with \`dsh --profile ${profile} --dump-config\`.`,
  ]
  const installEnabled = options.installDependencies !== false && env.EVAL_SKIP_INSTALL !== '1'
  const bundleInstalled = existsSync(join(profileDir, 'node_modules', '@codebam', 'dsh-jev-guardrails', 'package.json'))
  if (installEnabled && !bundleInstalled) {
    const runner = options.runPackageManager ?? defaultPackageManagerRunner
    let result: PackageManagerResult
    try {
      result = runner(profileDir)
    } catch (error) {
      result = {
        ok: false,
        command: 'pnpm install',
        output: error instanceof Error ? error.message : String(error),
      }
    }
    if (result.ok) {
      notes.push(`Installed profile dependencies with \`${result.command}\`.`)
    } else {
      warnings.push(
        `The bundle dependency is not installed yet. Run \`cd ${profileDir} && ${result.command}\` ` +
          `(or re-run without --no-install). Details: ${(result.output ?? '').split('\n').slice(-3).join(' ').trim()}`,
      )
    }
  } else if (bundleInstalled) {
    notes.push('The bundle dependency is already present in the profile\'s node_modules.')
  }

  if (resolved.apiKeySource === 'config') {
    notes.push(
      `A key was found in ${resolved.configPath}, but dsh reads EVAL_API_KEY from its process environment. ` +
        'Export EVAL_API_KEY (or run dsh from a shell that does) before starting dsh.',
    )
  } else if (resolved.apiKeySource === 'missing') {
    warnings.push(
      `No eval API key was found. Run \`eval-jev login --token eval_...\` and export EVAL_API_KEY before starting dsh (config: ${resolved.configPath}).`,
    )
  }

  const files = [manifestChange, patchChange]
  return {
    harness: 'dsh',
    scope: `profile:${profile}`,
    target: profileDir,
    changed: files.some((file) => file.status !== 'unchanged'),
    files,
    warnings,
    notes,
  }
}

function upsertPatchFile(path: string, baseUrl: string): FileChange {
  const existed = existsSync(path)
  const existing = existed ? readFileSync(path, 'utf8') : PATCH_HEADER
  const { text, changed } = upsertTopLevelYamlItem(existing, ROW_ID, () => renderDshPatchRow(baseUrl))
  if (!existed) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text, { mode: 0o644 })
    return { path, status: 'created' }
  }
  if (!changed) return { path, status: 'unchanged' }
  writeFileSync(path, text, { mode: 0o644 })
  return { path, status: 'updated' }
}

/** Run `pnpm install` (or `npm install` when pnpm is unavailable) in a profile. */
function defaultPackageManagerRunner(profileDir: string): PackageManagerResult {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const found = spawnSync(finder, ['pnpm'], { encoding: 'utf8' })
  const usePnpm = found.status === 0 && String(found.stdout).trim().length > 0
  const command = usePnpm ? 'pnpm' : 'npm'
  const args = usePnpm
    ? ['install', '--prefer-offline']
    : ['install', '--no-audit', '--no-fund', '--prefer-offline']
  const result = spawnSync(command, args, {
    cwd: profileDir,
    encoding: 'utf8',
    timeout: 180_000,
    env: process.env,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return {
    ok: result.status === 0,
    command: `${command} ${args.join(' ')}`,
    ...(output.length > 0 ? { output } : {}),
  }
}

/** True when an existing dependency spec should be replaced with our registry range. */
function shouldReplaceSpec(spec: string): boolean {
  const trimmed = spec.trim()
  if (trimmed.length === 0) return true
  if (trimmed.startsWith('.') || trimmed.startsWith('/')) return false
  if (trimmed.startsWith('file:') || trimmed.startsWith('link:') || trimmed.startsWith('workspace:') || trimmed.startsWith('portal:')) return false
  if (trimmed.startsWith('git+') || trimmed.startsWith('http:') || trimmed.startsWith('https:')) return false
  return trimmed !== DSH_GUARDRAILS_RANGE
}
