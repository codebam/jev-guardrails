#!/usr/bin/env node
/**
 * Link the workspace `node_modules/@deepseek-ai` to the installed dsh
 * closure's peer package set, so plugin tests resolve the exact packages dsh
 * resolves at runtime. No network access required.
 *
 * Usage: `npm run peers`
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const linkPath = join(repoRoot, 'node_modules', '@deepseek-ai')

function dshBin() {
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which'
    return execFileSync(finder, ['dsh'], { encoding: 'utf8' }).trim().split('\n')[0]
  } catch {
    return undefined
  }
}

function peerCandidates(root) {
  return [
    join(root, 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
    dirname(root),
    join(root, 'node_modules/@deepseek-ai'),
    join(root, 'lib/node_modules/@deepseek-ai'),
  ]
}

function isPeerDir(candidate) {
  return existsSync(join(candidate, 'dsh-tools'))
    && existsSync(join(candidate, 'dsh-llm'))
    && existsSync(join(candidate, 'schemastery'))
}

function dshPackageRoot() {
  const bin = dshBin()
  if (bin === undefined) return undefined
  const real = realpathSync(bin)
  const roots = [dirname(dirname(real))]
  try {
    const wrapper = readFileSync(real, 'utf8')
    for (const match of wrapper.matchAll(/\/nix\/store\/[a-z0-9]+-dsh-[^/\s"']+/g)) roots.unshift(match[0])
  } catch {
    // Not a readable wrapper; the derived root above still covers npm layouts.
  }
  for (const root of roots) {
    for (const candidate of peerCandidates(root)) {
      if (isPeerDir(candidate)) return candidate
    }
  }
  return undefined
}

const peers = dshPackageRoot()
if (peers === undefined) {
  console.error('link-dsh-peers: could not locate an installed dsh peer set.')
  process.exit(1)
}

rmSync(linkPath, { recursive: true, force: true })
mkdirSync(dirname(linkPath), { recursive: true })
symlinkSync(peers, linkPath, 'dir')
console.log(`link-dsh-peers: ${linkPath} -> ${peers}`)
