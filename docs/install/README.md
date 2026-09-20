# Install Eval Guardrails

Eval Guardrails is a paid guardrail service at `eval.seanbehan.ca`. Every
installation puts a **real hook in front of each tool call**, so a dangerous
action is evaluated before it executes, not just exposed as an MCP tool the
model can ignore.

| Harness | Interception seam | Install |
| --- | --- | --- |
| OpenCode | plugin `tool.execute.before` | `eval-jev install opencode` |
| Hermes Agent | plugin `pre_tool_call` hook | `eval-jev install hermes` |
| DeepSeek Harness | bundle `tools/pre-execute` listener | `eval-jev install dsh` |
| Any MCP client | remote/stdio MCP tools | MCP-only fallback (no automatic interception) |

## Common steps

```bash
# 1. sign in and store the API key (or paste an existing eval_ key)
npx -y @codebam/eval-jev-guardrails login

# 2. install the hook for your harness
npx -y @codebam/eval-jev-guardrails install opencode
npx -y @codebam/eval-jev-guardrails install hermes
npx -y @codebam/eval-jev-guardrails install dsh --profile web

# 3. add credits when needed
npx -y @codebam/eval-jev-guardrails buy --pack p5000 --open

# 4. prove the hook is live
npx -y @codebam/eval-jev-guardrails doctor opencode
```

`install` prints the files and config it changed. Every command is idempotent;
`--uninstall` reverses an install.

## Decision mapping

| Jev verdict | Hook behavior |
| --- | --- |
| `allow` | execute normally |
| `review` | deny by default (`EVAL_REVIEW_MODE=allow` to warn and continue) |
| `block` | deny, return the Jev reason to the model |
| `support` | deny, return the Jev reason to the model |

One tool call costs one credit. Failed provider calls are refunded by the
service. See [pricing](../pricing.md) and the [threat model](../threat-model.md) for packs and limits.
