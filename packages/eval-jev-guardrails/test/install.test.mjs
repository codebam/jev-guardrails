import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import {
  installDsh,
  installHermes,
  installOpenCode,
  renderOpenCodePluginSource,
  upsertTopLevelYamlItem,
} from '../dist/index.js'
import { startFakeEvalService } from './helpers/fake-service.mjs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const templateDir = join(packageRoot, 'templates', 'hermes', 'eval-jev-guardrails')

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('installOpenCode writes project files, is idempotent, and executes the generated hook', async () => {
  const service = await startFakeEvalService()
  const cwd = tempDir('eval-jev-opencode-')
  try {
    const first = installOpenCode({ cwd, env: {} })
    assert.equal(first.scope, 'project')
    assert.equal(first.changed, true)
    const packagePath = join(cwd, '.opencode', 'package.json')
    const pluginPath = join(cwd, '.opencode', 'plugins', 'eval-jev-guardrails.js')
    assert.ok(existsSync(packagePath))
    assert.ok(existsSync(pluginPath))
    const pkg = readJson(packagePath)
    assert.equal(pkg.type, 'module')
    assert.equal(pkg.dependencies['@codebam/eval-jev-guardrails'], '^0.1.0')
    assert.match(readFileSync(pluginPath, 'utf8'), /createOpenCodePlugin/)
    assert.match(readFileSync(pluginPath, 'utf8'), /@codebam\/eval-jev-guardrails\/opencode/)

    const second = installOpenCode({ cwd, env: {} })
    assert.equal(second.changed, false)
    assert.ok(second.files.every((file) => file.status === 'unchanged'))

    // Execute the generated module exactly as OpenCode would, resolving the
    // package from the local .opencode/node_modules link.
    const scoped = join(cwd, '.opencode', 'node_modules', '@codebam')
    mkdirSync(scoped, { recursive: true })
    symlinkSync(packageRoot, join(scoped, 'eval-jev-guardrails'), 'dir')
    const previousKey = process.env.EVAL_API_KEY
    const previousUrl = process.env.EVAL_BASE_URL
    process.env.EVAL_API_KEY = 'eval_test'
    process.env.EVAL_BASE_URL = service.url
    try {
      const module = await import(`${pathToFileURL(pluginPath).href}?t=${Date.now()}`)
      const hooks = module.EvalJevGuardrailsPlugin({ directory: '/repo' })
      await assert.rejects(
        () => hooks['tool.execute.before']({ tool: 'Bash', callID: 'c1' }, { args: { command: 'rm -rf /' } }),
        (error) => {
          assert.match(error.message, /Blocked by eval guardrails/)
          return true
        },
      )
      const request = service.requests.at(-1)
      assert.equal(request.body.action.workspace, '/repo')
      assert.equal(request.body.action.callID, 'c1')
    } finally {
      if (previousKey === undefined) delete process.env.EVAL_API_KEY
      else process.env.EVAL_API_KEY = previousKey
      if (previousUrl === undefined) delete process.env.EVAL_BASE_URL
      else process.env.EVAL_BASE_URL = previousUrl
    }
  } finally {
    await service.close()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('installOpenCode --global targets XDG_CONFIG_HOME/opencode', () => {
  const home = tempDir('eval-jev-opencode-home-')
  try {
    const env = { XDG_CONFIG_HOME: join(home, '.config') }
    const result = installOpenCode({ global: true, home, env })
    assert.equal(result.scope, 'global')
    assert.ok(existsSync(join(home, '.config', 'opencode', 'plugins', 'eval-jev-guardrails.js')))
    assert.ok(existsSync(join(home, '.config', 'opencode', 'package.json')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('renderOpenCodePluginSource is stable and self-describing', () => {
  const source = renderOpenCodePluginSource()
  assert.equal(source, renderOpenCodePluginSource())
  assert.match(source, /EVAL_REVIEW_MODE/)
  assert.match(source, /EVAL_FAIL_MODE/)
  assert.match(source, /export const EvalJevGuardrailsPlugin = createOpenCodePlugin\(\)/)
})

test('installHermes copies the template, calls hermes plugins enable, and is idempotent', () => {
  const home = tempDir('eval-jev-hermes-home-')
  const fakeBin = tempDir('eval-jev-hermes-bin-')
  const logPath = join(home, 'hermes-calls.log')
  try {
    const hermesScript = join(fakeBin, 'hermes')
    writeFileSync(hermesScript, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$HERMES_FAKE_LOG"\nexit 0\n`)
    chmodSync(hermesScript, 0o755)
    const env = {
      HOME: home,
      HERMES_HOME: join(home, '.hermes'),
      HERMES_FAKE_LOG: logPath,
      PATH: `${fakeBin}:${process.env.PATH}`,
    }
    const first = installHermes({ global: true, home, env })
    assert.equal(first.scope, 'global')
    assert.equal(first.changed, true)
    const installed = join(home, '.hermes', 'plugins', 'eval-jev-guardrails')
    assert.ok(existsSync(join(installed, 'plugin.yaml')))
    assert.ok(existsSync(join(installed, '__init__.py')))
    assert.equal(readFileSync(join(installed, '__init__.py'), 'utf8'), readFileSync(join(templateDir, '__init__.py'), 'utf8'))
    assert.ok(existsSync(logPath))
    assert.match(readFileSync(logPath, 'utf8'), /plugins enable eval-jev-guardrails/)

    const second = installHermes({ global: true, home, env })
    assert.equal(second.changed, false)
    assert.ok(second.files.every((file) => file.status === 'unchanged'))
    assert.equal(readFileSync(logPath, 'utf8').trim().split('\n').length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(fakeBin, { recursive: true, force: true })
  }
})

test('installHermes project scope writes .hermes and notes HERMES_ENABLE_PROJECT_PLUGINS', () => {
  const home = tempDir('eval-jev-hermes-project-home-')
  const cwd = tempDir('eval-jev-hermes-project-')
  try {
    const result = installHermes({ global: false, cwd, home, env: { PATH: '' } })
    assert.equal(result.scope, 'project')
    assert.ok(existsSync(join(cwd, '.hermes', 'plugins', 'eval-jev-guardrails', 'plugin.yaml')))
    assert.ok(result.notes.some((note) => note.includes('HERMES_ENABLE_PROJECT_PLUGINS=1')))
    assert.ok(result.notes.some((note) => note.includes('hermes plugins enable')))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('installDsh selects the bundle and writes a hosted provider override idempotently', () => {
  const home = tempDir('eval-jev-dsh-home-')
  const dshHome = join(home, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'ci')
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify(
        {
          name: 'dsh-profile-ci',
          private: true,
          dependencies: { '@deepseek-ai/dsh-headless': '^0.1.0' },
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
        },
        null,
        2,
      ),
    )
    writeFileSync(
      join(profileDir, 'cordis.patch.yml'),
      `# Keep this comment.\n- id: something-else\n  name: '@deepseek-ai/other'\n  config:\n    x: 1\n\n# Keep the next row too.\n- id: jev-guardrails\n  name: '@codebam/dsh-jev-guardrails'\n  config:\n    provider: typesafe\n`,
    )

    const first = installDsh({
      dshHome,
      profile: 'ci',
      home,
      env: { EVAL_BASE_URL: 'https://eval.example.test' },
      installDependencies: false,
    })
    assert.equal(first.scope, 'profile:ci')
    assert.equal(first.changed, true)
    assert.ok(first.warnings.some((warning) => warning.includes('No eval API key')))

    const manifest = readJson(join(profileDir, 'package.json'))
    assert.equal(manifest.dependencies['@codebam/dsh-jev-guardrails'], '^0.1.1')
    assert.ok(manifest.dsh.profile.bundles.includes('@codebam/dsh-jev-guardrails'))
    assert.equal(manifest.dependencies['@deepseek-ai/dsh-headless'], '^0.1.0')

    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /# Keep this comment\./)
    assert.match(patch, /# Keep the next row too\./)
    assert.match(patch, /id: something-else/)
    assert.match(patch, /config:\n    x: 1/)
    assert.match(patch, /provider: hosted/)
    assert.match(patch, /baseURL: https:\/\/eval\.example\.test/)
    assert.match(patch, /apiKey: !!js process\.env\.EVAL_API_KEY/)
    assert.match(patch, /actions: enforce/)
    assert.equal((patch.match(/id: jev-guardrails/g) ?? []).length, 1)
    assert.equal((patch.match(/provider: hosted/g) ?? []).length, 1)
    assert.doesNotMatch(patch, /provider: typesafe/)

    const second = installDsh({
      dshHome,
      profile: 'ci',
      home,
      env: { EVAL_BASE_URL: 'https://eval.example.test' },
      installDependencies: false,
    })
    assert.equal(second.changed, false)
    assert.ok(second.files.every((file) => file.status === 'unchanged'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installDsh auto-detects a single profile and creates a missing patch file', () => {
  const home = tempDir('eval-jev-dsh-single-')
  const dshHome = join(home, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'solo')
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'solo', dsh: { profile: { bundles: [] } } }))
    const result = installDsh({ dshHome, home, env: {}, installDependencies: false })
    assert.equal(result.scope, 'profile:solo')
    const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: jev-guardrails/)
    assert.match(patch, /provider: hosted/)
    assert.match(patch, /apiKey: !!js process\.env\.EVAL_API_KEY/)
    assert.match(patch, /actions: enforce/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installDsh refuses an unknown profile with an actionable error', () => {
  const home = tempDir('eval-jev-dsh-missing-')
  try {
    assert.throws(
      () => installDsh({ dshHome: join(home, '.dsh'), profile: 'nope', home, env: {}, installDependencies: false }),
      /profile "nope" was not found/,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('upsertTopLevelYamlItem replaces one item, preserves trivia, and is idempotent', () => {
  const source = `# header\n- id: a\n  config:\n    x: 1\n\n# note for b\n- id: b\n  config:\n    y: 2\n`
  const once = upsertTopLevelYamlItem(source, 'b', () => ['- id: b', '  config:', '    y: 3'])
  assert.equal(once.changed, true)
  assert.match(once.text, /# header/)
  assert.match(once.text, /# note for b/)
  assert.match(once.text, /y: 3/)
  assert.doesNotMatch(once.text, /y: 2/)
  const twice = upsertTopLevelYamlItem(once.text, 'b', () => ['- id: b', '  config:', '    y: 3'])
  assert.equal(twice.changed, false)
  assert.equal(twice.text, once.text)
})

test('installDsh runs the package manager only while the bundle dependency is missing', () => {
  const home = tempDir('eval-jev-dsh-install-home-')
  const dshHome = join(home, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'ci')
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'ci', dsh: { profile: { bundles: [] } } }))
    const calls = []
    const first = installDsh({
      dshHome,
      profile: 'ci',
      home,
      env: { EVAL_BASE_URL: 'https://eval.example.test' },
      runPackageManager: (dir) => {
        calls.push(dir)
        mkdirSync(join(dir, 'node_modules', '@codebam', 'dsh-jev-guardrails'), { recursive: true })
        writeFileSync(join(dir, 'node_modules', '@codebam', 'dsh-jev-guardrails', 'package.json'), '{}')
        return { ok: true, command: 'pnpm install' }
      },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0], profileDir)
    assert.ok(first.notes.some((note) => note.includes('Installed profile dependencies')))

    const second = installDsh({
      dshHome,
      profile: 'ci',
      home,
      env: { EVAL_BASE_URL: 'https://eval.example.test' },
      runPackageManager: () => {
        throw new Error('should not run when the dependency is present')
      },
    })
    assert.ok(second.notes.some((note) => note.includes('already present')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installDsh warns with the exact command when the package manager fails', () => {
  const home = tempDir('eval-jev-dsh-install-fail-')
  const dshHome = join(home, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'ci')
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'ci', dsh: { profile: { bundles: [] } } }))
    const result = installDsh({
      dshHome,
      profile: 'ci',
      home,
      env: { EVAL_BASE_URL: 'https://eval.example.test' },
      runPackageManager: () => ({ ok: false, command: 'pnpm install', output: 'pnpm: not found' }),
    })
    assert.ok(result.warnings.some((warning) => warning.includes('The bundle dependency is not installed yet')))
    assert.ok(result.warnings.some((warning) => warning.includes('pnpm install')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('CLI install dsh --no-install writes the profile without touching a package manager', async () => {
  const { runCli } = await import('../dist/cli.js')
  const home = tempDir('eval-jev-dsh-cli-home-')
  const dshHome = join(home, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'cli')
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'cli', dsh: { profile: { bundles: [] } } }))
    const output = []
    const code = await runCli(
      ['install', 'dsh', '--profile', 'cli', '--dsh-home', dshHome, '--no-install'],
      { stdout: (m) => output.push(m), stderr: (m) => output.push(m), env: { EVAL_BASE_URL: 'https://eval.example.test' }, home, cwd: home },
    )
    assert.equal(code, 0)
    assert.ok(output.join('').includes('created') || output.join('').includes('updated'))
    assert.ok(!existsSync(join(profileDir, 'node_modules', '@codebam', 'dsh-jev-guardrails')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
