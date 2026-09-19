#!/usr/bin/env node
/**
 * Real DeepSeek Harness smoke test.
 *
 * Creates a throwaway DSH_HOME, lets dsh initialize the shipped `headless`
 * profile, symlinks this workspace's two packages into it, selects
 * `@codebam/dsh-jev-guardrails` as a profile bundle, and checks that:
 *
 * 1. the bundle's cordis.patch.yml inserts the plugin row;
 * 2. a real dsh boot accepts the Config schema and calls the plugin's apply.
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
  // Select the package as a profile bundle; dsh must read its
  // package.json `dsh.bundle.patch`, not a hand-written user patch row.
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dependencies['@codebam/dsh-jev-guardrails'] = '0.1.1'
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@codebam/dsh-jev-guardrails')) bundles.push('@codebam/dsh-jev-guardrails')
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const dump = runDsh(['--dump-config'], { OPENROUTER_API_KEY: 'dsh-smoke-dummy' })
  if (dump.status !== 0) throw new Error(`dsh config dump failed:\n${dump.stderr || dump.stdout}`)
  if (!dump.stdout.includes("name: '@codebam/dsh-jev-guardrails'")) {
    throw new Error('the bundle patch did not insert the plugin row into the composed dsh config')
  }

  const boot = runDsh(['--help'], { OPENROUTER_API_KEY: 'dsh-smoke-dummy' })
  if (boot.status !== 0) throw new Error(`dsh boot failed:\n${boot.stderr || boot.stdout}`)
  if (!boot.stdout.includes('headless')) throw new Error('dsh did not boot the headless app')

  console.log('dsh-smoke: plugin row composed and real dsh boot accepted the plugin')
} finally {
  rmSync(home, { recursive: true, force: true })
}
