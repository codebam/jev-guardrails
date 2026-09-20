# OpenCode

Eval Guardrails installs a local OpenCode plugin that uses the real
`tool.execute.before` hook. The hook runs before the tool body, so a blocked
call never executes.

## Install

```bash
npx -y @codebam/eval-jev-guardrails login
npx -y @codebam/eval-jev-guardrails install opencode
```

The installer writes:

- `.opencode/package.json` — adds `@codebam/eval-jev-guardrails`
- `.opencode/plugins/eval-jev-guardrails.js` — the hook

Use `--global` to write the equivalent files under
`~/.config/opencode/` instead. Restart OpenCode after installing (or start a
new session), then run `doctor opencode`.

## What it does

```js
// .opencode/plugins/eval-jev-guardrails.js
import { createOpenCodePlugin } from '@codebam/eval-jev-guardrails/opencode'

export default createOpenCodePlugin()
```

For every tool call OpenCode sends the tool name, parsed arguments, and
workspace to `POST /v1/evaluate`. `block` and `support` throw an error with the
model-facing reason; OpenCode fails the tool call before `item.execute()` runs.
`review` is denied by default so an uncertain call cannot slip through while
nobody is looking.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `EVAL_API_KEY` | config file | `eval_...` key |
| `EVAL_BASE_URL` | `https://eval.seanbehan.ca` | service base URL |
| `EVAL_REVIEW_MODE` | `deny` | `deny` or `allow` for the `review` verdict |
| `EVAL_FAIL_MODE` | `open` | `open`, `review`, or `closed` if the service is unreachable |
| `EVAL_SKIP_TOOLS` | — | comma-separated exact tool names to skip |
| `EVAL_GUARD_TOOLS` | all | comma-separated allow-list of tool names to guard |

## Verify

```bash
npx -y @codebam/eval-jev-guardrails doctor opencode
```

Then ask the agent to run a destructive command such as
`rm -rf /tmp/eval-guardrails-canary`. The tool call should be denied with a
Jev guardrails reason before the command runs.
