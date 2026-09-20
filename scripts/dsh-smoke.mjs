#!/usr/bin/env node
/**
 * Real DeepSeek Harness smoke test.
 *
 * Creates a throwaway DSH_HOME, lets dsh initialize the shipped `headless`
 * profile, symlinks this workspace's packages into it, runs the real
 * `eval-jev install dsh` installer against that profile, and checks that:
 *
 * 1. the installer selects the bundle and writes the hosted-provider row;
 * 2. the bundle's cordis.patch.yml composes into a real dsh config dump;
 * 3. a real dsh boot accepts the Config schema and calls the plugin's apply.
 *
 * It does not call a model or a guardrail provider. Exits 0 with a skip notice
 * when `dsh` is not on PATH.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function whichDsh() {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(finder, ['dsh'], { encoding: 'utf8' }).trim().split('\n')[0]
  } catch {
    return undefined
  }
}

const dshBin = whichDsh()
if (dshBin === undefined) {
  console.log('dsh-smoke: skipped (dsh is not on PATH)')
  process.exit(0)
}

// The plugin's peer dependencies resolve from the workspace link created by
// scripts/link-dsh-peers.mjs, which also verifies the installed dsh closure.
execFileSync(process.execPath, [join(repoRoot, 'scripts/link-dsh-peers.mjs')], { stdio: 'inherit' })

const home = mkdtempSync(join(tmpdir(), 'dsh-jev-smoke-'))
const dshHome = join(home, 'dsh-home')
mkdirSync(dshHome, { recursive: true })

function runDsh(args, extraEnv = {}) {
  return spawnSync(dshBin, ['--profile', 'headless', ...args], {
    cwd: home,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      ...extraEnv,
    },
    encoding: 'utf8',
  })
}

try {
  const init = runDsh(['--dump-config'])
  if (init.status !== 0) {
    throw new Error(`dsh profile initialization failed:\n${init.stderr || init.stdout}`)
  }

  const profile = join(dshHome, 'profiles', 'headless')
  const scoped = join(profile, 'node_modules', '@codebam')
  mkdirSync(scoped, { recursive: true })
  for (const packageName of ['jev-guardrails', 'dsh-jev-guardrails']) {
    const target = join(repoRoot, 'packages', packageName)
    const link = join(scoped, packageName)
    if (existsSync(link)) rmSync(link, { recursive: true, force: true })
    symlinkSync(target, link, 'dir')
  }
  // Run the real product installer. --no-install keeps the smoke hermetic;
  // the package is already reachable through the symlinks above.
  const installer = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'packages', 'eval-jev-guardrails', 'dist', 'bin.js'),
      'install', 'dsh',
      '--profile', 'headless',
      '--dsh-home', dshHome,
      '--no-install',
    ],
    {
      cwd: home,
      env: { ...process.env, EVAL_BASE_URL: 'https://eval.seanbehan.ca' },
      encoding: 'utf8',
    },
  )
  if (installer.status !== 0) throw new Error(`eval-jev install dsh failed:\n${installer.stderr || installer.stdout}`)

  const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  if (!patch.includes('provider: hosted')) throw new Error('the installer did not write a hosted provider row')
  if (!patch.includes('apiKey: !!js process.env.EVAL_API_KEY')) throw new Error('the installer did not reference EVAL_API_KEY')

  const dump = runDsh(['--dump-config'], { EVAL_API_KEY: 'dsh-smoke-dummy' })
  if (dump.status !== 0) throw new Error(`dsh config dump failed:\n${dump.stderr || dump.stdout}`)
  if (!dump.stdout.includes("name: '@codebam/dsh-jev-guardrails'")) {
    throw new Error('the bundle patch did not insert the plugin row into the composed dsh config')
  }
  if (!dump.stdout.includes('provider: hosted')) throw new Error('the composed dsh config did not adopt the hosted provider override')

  const boot = runDsh(['--help'], { EVAL_API_KEY: 'dsh-smoke-dummy' })
  if (boot.status !== 0) throw new Error(`dsh boot failed:\n${boot.stderr || boot.stdout}`)
  if (!boot.stdout.includes('headless')) throw new Error('dsh did not boot the headless app')

  console.log('dsh-smoke: plugin row composed and real dsh boot accepted the plugin')
} finally {
  rmSync(home, { recursive: true, force: true })
}
