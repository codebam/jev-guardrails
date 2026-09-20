import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installDsh, installHermes, installOpenCode, runCli, runDoctor } from '../dist/index.js'
import { startFakeEvalService } from './helpers/fake-service.mjs'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'eval-jev-doctor-'))
}

function capture() {
  const stdout = []
  const stderr = []
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
  }
}

test('doctor fails when the key is missing', async () => {
  const home = tempHome()
  try {
    const report = await runDoctor({ home, env: {}, checkService: false })
    assert.equal(report.ok, false)
    const keyCheck = report.checks.find((check) => check.name === 'api key')
    assert.equal(keyCheck.status, 'fail')
    assert.match(keyCheck.detail, /EVAL_API_KEY/)
    assert.match(keyCheck.detail, /eval-jev login/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor succeeds with a key and a reachable service, and warns for uninstalled harnesses', async () => {
  const service = await startFakeEvalService()
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-doctor-cwd-'))
  try {
    const report = await runDoctor({
      home,
      cwd,
      env: { EVAL_API_KEY: 'eval_test', EVAL_BASE_URL: service.url },
    })
    assert.equal(report.ok, true)
    const serviceCheck = report.checks.find((check) => check.name === 'service')
    assert.equal(serviceCheck.status, 'ok')
    assert.match(serviceCheck.detail, /remaining 37/)
    assert.ok(report.checks.filter((check) => check.status === 'warn').length >= 3)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('doctor verifies an installed OpenCode hook', async () => {
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-doctor-opencode-'))
  try {
    installOpenCode({ cwd, home, env: {} })
    const report = await runDoctor({
      harness: 'opencode',
      scope: 'project',
      cwd,
      home,
      env: {},
      apiKey: 'eval_test',
      checkService: false,
    })
    assert.equal(report.ok, true)
    const check = report.checks.find((entry) => entry.name === 'opencode hook')
    assert.equal(check.status, 'ok')
    assert.match(check.detail, /\.opencode/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('doctor verifies an installed Hermes hook', async () => {
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-doctor-hermes-'))
  try {
    installHermes({ global: true, cwd, home, env: { HERMES_HOME: join(home, '.hermes'), PATH: '' }, enable: false })
    const report = await runDoctor({ harness: 'hermes', home, cwd, env: {}, apiKey: 'eval_test', checkService: false })
    assert.equal(report.ok, true)
    const check = report.checks.find((entry) => entry.name === 'hermes hook')
    assert.equal(check.status, 'ok')
    assert.match(check.detail, /plugin/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('doctor verifies an installed dsh bundle', async () => {
  const home = tempHome()
  const dshHome = join(home, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'ci')
  try {
    installDshFixture(profileDir)
    installDsh({ dshHome, profile: 'ci', home, env: { EVAL_API_KEY: 'eval_test' } })
    const report = await runDoctor({ harness: 'dsh', dshHome, profile: 'ci', home, env: {}, apiKey: 'eval_test', checkService: false })
    assert.equal(report.ok, true)
    const check = report.checks.find((entry) => entry.name === 'dsh bundle')
    assert.equal(check.status, 'ok')
    assert.match(check.detail, /provider hosted/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('CLI login writes a mode-600 config; credits and doctor exercise the CLI', async () => {
  const service = await startFakeEvalService()
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-cli-'))
  try {
    const login = capture()
    const loginCode = await runCli(['login', '--token', 'eval_cli_test'], {
      ...login.io,
      env: {},
      home,
      cwd,
    })
    assert.equal(loginCode, 0)
    const configPath = join(home, '.config', 'eval-jev', 'config.json')
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).apiKey, 'eval_cli_test')
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    assert.match(login.stdout(), /Stored eval_cl…test/)
    assert.match(login.stdout(), /mode 600/)

    const credits = capture()
    const creditsCode = await runCli(['credits', '--json'], {
      ...credits.io,
      env: { EVAL_API_KEY: 'eval_test', EVAL_BASE_URL: service.url },
      home,
      cwd,
    })
    assert.equal(creditsCode, 0)
    assert.deepEqual(JSON.parse(credits.stdout()).remaining, 37)

    const doctor = capture()
    const doctorCode = await runCli(['doctor', '--offline', '--json'], {
      ...doctor.io,
      env: {},
      home: tempHome(),
      cwd,
    })
    const report = JSON.parse(doctor.stdout())
    assert.equal(doctorCode, 1)
    assert.equal(report.ok, false)

    const install = capture()
    const installCode = await runCli(['install', 'opencode'], {
      ...install.io,
      env: {},
      home,
      cwd,
    })
    assert.equal(installCode, 0)
    assert.match(install.stdout(), /created/)
    assert.match(install.stdout(), /eval-jev-guardrails\.js/)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CLI login without --token uses the GitHub device flow', async () => {
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-cli-device-'))
  const requests = []
  try {
    const fakeFetch = async (url) => {
      requests.push(String(url))
      if (String(url).endsWith('/v1/auth/device')) {
        return new Response(
          JSON.stringify({
            device_code: 'device-1',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://github.com/login/device',
            interval: 0,
            expires_in: 60,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (String(url).endsWith('/v1/auth/device/token')) {
        return new Response(JSON.stringify({ apiKey: 'eval_device_flow', login: 'tester', credits: 250 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    }
    const login = capture()
    const code = await runCli(['login'], { ...login.io, env: {}, home, cwd, fetch: fakeFetch })
    assert.equal(code, 0)
    assert.deepEqual(requests, ['https://eval.seanbehan.ca/v1/auth/device', 'https://eval.seanbehan.ca/v1/auth/device/token'])
    assert.match(login.stdout(), /Enter code: ABCD-EFGH/)
    const configPath = join(home, '.config', 'eval-jev', 'config.json')
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).apiKey, 'eval_device_flow')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CLI rejects unknown commands and missing key on credits', async () => {
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-cli2-'))
  try {
    const unknown = capture()
    assert.equal(await runCli(['frobnicate'], { ...unknown.io, env: {}, home, cwd }), 2)
    assert.match(unknown.stderr(), /unknown command/)

    const credits = capture()
    assert.equal(await runCli(['credits'], { ...credits.io, env: {}, home, cwd }), 1)
    assert.match(credits.stderr(), /EVAL_API_KEY/)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CLI buy posts the pack, prints the Stripe URL, and honors --open/--json', async () => {
  const service = await startFakeEvalService()
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-cli-buy-'))
  try {
    const env = { EVAL_API_KEY: 'eval_test', EVAL_BASE_URL: service.url }
    const opened = []
    const buy = capture()
    const buyCode = await runCli(['buy', '--pack', 'p5000', '--open'], {
      ...buy.io,
      env,
      home,
      cwd,
      openExternal: (url) => opened.push(url),
    })
    assert.equal(buyCode, 0)
    assert.match(buy.stdout(), /Stripe Checkout URL: https:\/\/checkout\.stripe\.test\/session\/p5000/)
    assert.match(buy.stdout(), /Checkout session: cs_test_p5000/)
    assert.deepEqual(opened, ['https://checkout.stripe.test/session/p5000'])

    const request = service.requests.at(-1)
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/billing/checkout')
    assert.equal(request.headers.authorization, 'Bearer eval_test')
    assert.deepEqual(request.body, { pack: 'p5000' })

    const json = capture()
    const jsonCode = await runCli(['buy', '--pack', 'p25000', '--json'], { ...json.io, env, home, cwd })
    assert.equal(jsonCode, 0)
    const parsed = JSON.parse(json.stdout())
    assert.equal(parsed.id, 'cs_test_p25000')
    assert.equal(parsed.url, 'https://checkout.stripe.test/session/p25000')
    assert.equal(service.requests.length, 2)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('CLI buy rejects an invalid or missing --pack with exit 2 before calling the service', async () => {
  const service = await startFakeEvalService()
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-cli-buy-bad-'))
  try {
    const env = { EVAL_API_KEY: 'eval_test', EVAL_BASE_URL: service.url }
    const invalid = capture()
    assert.equal(await runCli(['buy', '--pack', 'p1'], { ...invalid.io, env, home, cwd }), 2)
    assert.match(invalid.stderr(), /--pack must be one of p5000, p25000, p100000, p500000/)
    assert.match(invalid.stderr(), /p1/)

    const missing = capture()
    assert.equal(await runCli(['buy'], { ...missing.io, env, home, cwd }), 2)
    assert.match(missing.stderr(), /--pack/)

    assert.equal(service.requests.length, 0)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('doctor suggests eval-jev buy when credits are low without changing exit semantics', async () => {
  const service = await startFakeEvalService()
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-doctor-low-'))
  try {
    const env = { EVAL_API_KEY: 'eval_test', EVAL_BASE_URL: service.url }
    const report = await runDoctor({ env, home, cwd })
    assert.equal(report.ok, true)
    const serviceCheck = report.checks.find((check) => check.name === 'service')
    assert.equal(serviceCheck.status, 'ok')
    assert.match(serviceCheck.detail, /remaining 37/)
    assert.match(serviceCheck.detail, /eval-jev buy --pack p5000/)

    const cli = capture()
    const code = await runCli(['doctor'], { ...cli.io, env, home, cwd })
    assert.equal(code, 0)
    assert.match(cli.stdout(), /eval-jev buy --pack p5000/)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('doctor omits the buy suggestion when the balance is healthy', async () => {
  const service = await startFakeEvalService({
    route: (request) =>
      request.url === '/v1/credits' ? { status: 200, body: { remaining: 5000, total: 5000 } } : undefined,
  })
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-doctor-healthy-'))
  try {
    const report = await runDoctor({ env: { EVAL_API_KEY: 'eval_test', EVAL_BASE_URL: service.url }, home, cwd })
    assert.equal(report.ok, true)
    const serviceCheck = report.checks.find((check) => check.name === 'service')
    assert.equal(serviceCheck.status, 'ok')
    assert.doesNotMatch(serviceCheck.detail, /eval-jev buy/)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

function installDshFixture(profileDir) {
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-ci', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  )
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '# profile patch\n[]\n')
}

test('CLI buy --promo forwards a valid code and rejects an invalid one locally', async () => {
  const service = await startFakeEvalService()
  const home = tempHome()
  const cwd = mkdtempSync(join(tmpdir(), 'eval-jev-cli-promo-'))
  try {
    const env = { EVAL_API_KEY: 'eval_test', EVAL_BASE_URL: service.url }
    const buy = capture()
    assert.equal(await runCli(['buy', '--pack', 'p5000', '--promo', 'SAVE10'], { ...buy.io, env, home, cwd }), 0)
    assert.match(buy.stdout(), /Stripe Checkout URL: https:\/\/checkout\.stripe\.test\/session\/p5000/)
    assert.deepEqual(service.requests.at(-1).body, { pack: 'p5000', promotionCode: 'SAVE10' })

    const invalid = capture()
    assert.equal(await runCli(['buy', '--pack', 'p5000', '--promo', 'bad code!'], { ...invalid.io, env, home, cwd }), 2)
    assert.match(invalid.stderr(), /promotion code/)
    assert.equal(service.requests.length, 1)
  } finally {
    await service.close()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})
