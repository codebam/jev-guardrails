# @codebam/eval-jev-guardrails

Client SDK and CLI for the hosted [`eval.seanbehan.ca`](https://eval.seanbehan.ca)
guardrails service, plus **real tool-call hooks** for three agent harnesses:

| Harness | Seam | Behavior on `block` / `support` |
| --- | --- | --- |
| [OpenCode](https://opencode.ai) | `tool.execute.before` | throws before the tool executes |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | `pre_tool_call` | returns `{"action":"block","message":...}` |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `tools/pre-execute` (via `@codebam/dsh-jev-guardrails`) | bundle denies / asks per plugin policy |

Every hook calls `POST /v1/evaluate` on the hosted service with
`side: "action"` and the proposed tool call. A `block` or `support` verdict
stops the call before it runs. A `review` verdict stops the call by default;
set `EVAL_REVIEW_MODE=allow` to let reviews through with a warning.

## One-command installs

Log in first. With no token this starts the service's GitHub device flow and
stores the minted key in a mode-600 config at `~/.config/eval-jev/config.json`:

```bash
# Any of the commands below can be run with npx:
npx @codebam/eval-jev-guardrails login            # GitHub device flow
npx @codebam/eval-jev-guardrails login --token eval_...   # CI / --token fallback
```

Then install the hook for the harness you use:

```bash
# OpenCode: project .opencode/plugins/, or --global for ~/.config/opencode
npx @codebam/eval-jev-guardrails install opencode
npx @codebam/eval-jev-guardrails install opencode --global

# Hermes Agent: project .hermes/plugins/, or --global for ~/.hermes/plugins
npx @codebam/eval-jev-guardrails install hermes
npx @codebam/eval-jev-guardrails install hermes --global

# DeepSeek Harness: select the hosted bundle inside one dsh profile
npx @codebam/eval-jev-guardrails install dsh --profile <profile>
```

Every installer is idempotent: it prints `created`, `updated`, or
`unchanged` for each file and re-running it is a no-op. Run
`eval-jev doctor [opencode|hermes|dsh]` to verify the key, the service, and
the installed hook files.

> The package is not published yet in this repo checkout. From the workspace
> you can run the same commands directly: `node packages/eval-jev-guardrails/dist/bin.js install …`.

### Buy credits

```bash
npx @codebam/eval-jev-guardrails buy --pack p25000         # print the Stripe URL
npx @codebam/eval-jev-guardrails buy --pack p5000 --open   # also open the browser
npx @codebam/eval-jev-guardrails buy --pack p500000 --json
```

Packs: `p5000` (5,000 credits), `p25000` (25,000), `p100000` (100,000),
`p500000` (500,000). See [`docs/pricing.md`](../../docs/pricing.md) for
pricing. The command calls `POST /v1/billing/checkout` with your eval key and
prints the hosted Stripe Checkout Session URL; credits are added by the
service after Stripe's webhook confirms payment. `eval-jev doctor` suggests
`eval-jev buy --pack p5000` when the balance drops below 50.

### OpenCode

The installer writes:

- `.opencode/package.json` (or `~/.config/opencode/package.json`) with the
  `@codebam/eval-jev-guardrails` dependency, and
- `.opencode/plugins/eval-jev-guardrails.js` (or global equivalent), which
  imports `createOpenCodePlugin()` and exports `EvalJevGuardrailsPlugin`.

OpenCode auto-loads the local plugin on the next start. The plugin file reads
the key/base URL at hook time from the environment or the shared config file.

### Hermes Agent

The installer copies the real Python plugin from
`templates/hermes/eval-jev-guardrails/` into `~/.hermes/plugins/` (global) or
`<project>/.hermes/plugins/` (project) and runs
`hermes plugins enable eval-jev-guardrails` when `hermes` is on `PATH`.

Project plugins are only discovered when Hermes starts with
`HERMES_ENABLE_PROJECT_PLUGINS=1`. The plugin is dependency-free (stdlib
`urllib`) and returns a `{"action":"block","message":...}` directive from
`pre_tool_call`.

### DeepSeek Harness

The installer edits the chosen profile under `$DSH_HOME/profiles/<name>/`:

- adds `@codebam/dsh-jev-guardrails` to `dependencies` and to
  `dsh.profile.bundles`, and
- upserts the `jev-guardrails` row in the profile's `cordis.patch.yml`:

```yaml
- id: jev-guardrails
  name: '@codebam/dsh-jev-guardrails'
  config:
    provider: hosted
    baseURL: https://eval.seanbehan.ca
    apiKey: !!js process.env.EVAL_API_KEY
    actions: enforce
```

No secret is written to the profile. Export `EVAL_API_KEY` in the environment
that launches `dsh`. (`EVAL_BASE_URL` is honoured when resolving the base URL
to write; the profile keeps the resolved URL.)

## Client API

```ts
import { EvalGuardrailsClient } from '@codebam/eval-jev-guardrails'

const client = new EvalGuardrailsClient()

const { verdict, credits } = await client.evaluate(
  'action',
  { tool: 'Bash', arguments: { command: 'rm -rf /' } },
  { tool: 'Bash', arguments: { command: 'rm -rf /' }, workspace: process.cwd() },
)

if (verdict.action === 'block' || verdict.action === 'support') {
  throw new Error(verdict.reason)
}

await client.systemOne({ state: 'text', questions: { /* ... */ } })
await client.credits()
await client.me()

const checkout = await client.checkout('p25000')
console.log(checkout.url) // hosted Stripe Checkout Session
```

`evaluate(side, state, action?)` accepts `side: input | output | observation |
action`; `action` is required when `side` is `action`.

## Configuration

Resolution order per field:

| Field | First | Then | Then | Fallback |
| --- | --- | --- | --- | --- |
| API key | constructor `apiKey` | `EVAL_API_KEY` | `~/.config/eval-jev/config.json` `apiKey` | missing (requests fail with a clear error) |
| Base URL | constructor `baseUrl` | `EVAL_BASE_URL` | config file `baseUrl` / `baseURL` | `https://eval.seanbehan.ca` |

The config file path can be overridden with `EVAL_CONFIG_PATH`; XDG users get
`$XDG_CONFIG_HOME/eval-jev/config.json`. `eval-jev login` starts the service's
GitHub device flow and writes the resulting key with mode `600`;
`eval-jev login --token eval_...` remains supported for CI and for servers
where the device flow is unavailable.

Hook policy env vars:

- `EVAL_REVIEW_MODE=deny|allow` — `deny` (default) blocks a `review` verdict.
- `EVAL_FAIL_MODE=open|review|closed` — behavior when the service is
  unreachable. Default `open` (the harness keeps working); `closed` blocks;
  `review` applies the review policy (blocked by default).
- `EVAL_SKIP_TOOLS=Read,List` — exact tool names to pass through (OpenCode).
- `EVAL_TIMEOUT_MS=5000` — per-request timeout.

## CLI

```text
eval-jev login [--token eval_...] [--base-url <url>] [--config <path>]
eval-jev install opencode [--project|--global]
eval-jev install hermes   [--project|--global]
eval-jev install dsh      [--profile <name>] [--dsh-home <path>] [--no-install]
eval-jev buy --pack <p5000|p25000|p100000|p500000> [--open] [--json]
eval-jev doctor [opencode|hermes|dsh] [--project|--global] [--offline] [--json]
eval-jev credits [--json]
eval-jev version
```

`doctor` exits non-zero when the key is missing or the service cannot be
reached, and prints a `buy` hint when the balance is low (exit status is
unchanged). `credits` prints the remaining balance. `buy` exits `2` for an
invalid `--pack` before making any request.

## Development

```bash
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # build + node:test against a local node:http fake service
npm run check       # typecheck + syntax checks
```

Tests never call the real service: `test/helpers/fake-service.mjs` implements
`/v1/evaluate`, `/v1/systemone`, `/v1/credits`, `/v1/me`, and
`/v1/billing/checkout`, and the Hermes test drives the generated Python plugin
against that fake via `python3`.

## License

MIT
