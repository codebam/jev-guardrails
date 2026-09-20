/**
 * Local node:http fake of the eval.seanbehan.ca API.
 *
 * Tests never call the real service: they start this server, point the client
 * or a generated hook at `service.url`, and inspect `service.requests`.
 */
import { createServer } from 'node:http'

/** Build a standard evaluate verdict. */
export function verdict(action, extra = {}) {
  return {
    action,
    side: 'action',
    kind: 'action',
    hazards: action === 'allow' ? { destructive: 0.01 } : { destructive: 0.97 },
    severity: action === 'allow' ? 0.1 : 2.4,
    reason:
      action === 'block'
        ? 'Blocked by eval guardrails: this tool call looks destructive (97%). Do not retry it.'
        : action === 'review'
          ? 'Flagged for review by eval guardrails: this tool call looks destructive (75%).'
          : action === 'support'
            ? 'Jev guardrails flagged this tool call; stop and respond supportively.'
            : 'passed eval guardrails',
    model: 'fake/jev-test',
    usage: { input_tokens: 10, output_tokens: 4, cost: 0.00001 },
    cached: false,
    degraded: false,
    ...extra,
  }
}

/** Default response for one request body. */
export function defaultEvaluation(body) {
  const serialized = JSON.stringify(body?.action ?? {})
  const command = typeof body?.action?.arguments?.command === 'string' ? body.action.arguments.command : ''
  let action = 'allow'
  if (/rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|mkfs|shred|dd\s+if=/.test(serialized) || /rm\s+-rf/.test(command)) {
    action = 'block'
  } else if (/review-me/.test(serialized)) {
    action = 'review'
  } else if (/support-me/.test(serialized)) {
    action = 'support'
  }
  return { verdict: verdict(action), credits: { remaining: 41, charged: 1 } }
}

/**
 * Start the fake service.
 *
 * @param {{route?: (record: {method: string, url: string, headers: Record<string,string|string[]|undefined>, body: unknown, raw: string}) => ({status?: number, body: unknown} | undefined)}} [options]
 */
export async function startFakeEvalService(options = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = raw.trim().length > 0 ? JSON.parse(raw) : undefined
    } catch {
      body = raw
    }
    const record = {
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      headers: request.headers,
      body,
      raw,
    }
    requests.push(record)

    const respond = (status, payload) => {
      const text = JSON.stringify(payload)
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      response.end(text)
    }

    const custom = options.route?.(record)
    if (custom !== undefined) {
      respond(custom.status ?? 200, custom.body)
      return
    }

    if (record.method === 'POST' && record.url === '/v1/evaluate') {
      respond(200, defaultEvaluation(body))
      return
    }
    if (record.method === 'POST' && record.url === '/v1/systemone') {
      const questions = body?.questions ?? {}
      const answers = {}
      for (const [name, question] of Object.entries(questions)) {
        if (question?.type === 'noul') answers[name] = { type: 'noul', noul: 0.12 }
        else if (question?.type === 'score') answers[name] = { type: 'score', score: 1.5 }
        else answers[name] = { type: 'choice', choice: 'fake' }
      }
      respond(200, { model: 'fake/jev-test', answers, usage: { input_tokens: 5, output_tokens: 2 } })
      return
    }
    if (record.method === 'GET' && record.url === '/v1/credits') {
      respond(200, { remaining: 37, total: 100 })
      return
    }
    if (record.method === 'GET' && record.url === '/v1/me') {
      respond(200, { id: 'user-1', login: 'tester', email: 'tester@example.com', credits: 37 })
      return
    }
    if (record.method === 'POST' && record.url === '/v1/billing/checkout') {
      const pack = typeof body?.pack === 'string' ? body.pack : 'unknown'
      respond(200, {
        url: `https://checkout.stripe.test/session/${pack}`,
        id: `cs_test_${pack}`,
      })
      return
    }
    respond(404, { error: 'not found' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    server,
  }
}
