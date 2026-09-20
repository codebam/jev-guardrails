# Hermes Agent

Eval Guardrails installs a directory plugin under `~/.hermes/plugins/` that
registers Hermes' `pre_tool_call` lifecycle hook. The hook receives every tool
call before dispatch and returns `{"action":"block","message":...}` when the
call must not run.

## Install

```bash
npx -y @codebam/eval-jev-guardrails login
npx -y @codebam/eval-jev-guardrails install hermes
```

The installer copies:

- `~/.hermes/plugins/eval-jev-guardrails/plugin.yaml`
- `~/.hermes/plugins/eval-jev-guardrails/__init__.py`

and runs `hermes plugins enable eval-jev-guardrails` when `hermes` is on PATH.
Use `--project` to install into `./.hermes/plugins/`; that path requires
`HERMES_ENABLE_PROJECT_PLUGINS=1`.

## What it does

```python
def register(ctx):
    ctx.register_hook("pre_tool_call", pre_tool_call)
```

For every tool call, the plugin calls `POST /v1/evaluate` with the tool name,
arguments, and session/task ids. A `block` or `support` verdict returns a block
directive, so Hermes returns the reason as the tool result instead of running
the action. `review` is blocked by default.

Hermes fails hook callbacks open on exceptions. Set `EVAL_FAIL_MODE=closed` in
the environment that launches Hermes if an unavailable service should block
instead.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `EVAL_API_KEY` | config file | `eval_...` key |
| `EVAL_BASE_URL` | `https://eval.seanbehan.ca` | service base URL |
| `EVAL_REVIEW_MODE` | `deny` | `deny` or `allow` for the `review` verdict |
| `EVAL_FAIL_MODE` | `open` | `open`, `review`, or `closed` |
| `EVAL_TIMEOUT_MS` | `5000` | per-call timeout |
| `EVAL_SKIP_TOOLS` | — | comma-separated exact tool names to skip |

## Verify

```bash
hermes plugins list | grep eval-jev-guardrails
npx -y @codebam/eval-jev-guardrails doctor hermes
```

Then ask Hermes to run `rm -rf /tmp/eval-guardrails-canary`; the `pre_tool_call`
hook should return a block message before the terminal tool runs.
