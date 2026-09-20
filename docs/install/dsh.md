# DeepSeek Harness

DeepSeek Harness already has the native bundle
`@codebam/dsh-jev-guardrails`, which evaluates every tool call through its
`tools/pre-execute` listener. Eval Guardrails only needs to select that bundle
and point it at the hosted service.

## Install

```bash
npx -y @codebam/eval-jev-guardrails login
npx -y @codebam/eval-jev-guardrails install dsh --profile web
```

The installer:

1. adds `@codebam/dsh-jev-guardrails` to the profile's dependencies and
   `dsh.profile.bundles`;
2. writes a row with `id: jev-guardrails` in the profile's `cordis.patch.yml`
   with `provider: hosted`, the eval base URL, and
   `apiKey: !!js process.env.EVAL_API_KEY`;
3. runs `pnpm install` (or `npm install`) in the profile so the bundle package
   is actually present; if no package manager is available, it prints the exact
   command instead and exits successfully;
4. leaves existing config untouched.
Set `EVAL_SKIP_INSTALL=1` or pass `--no-install` to skip step 3 in offline
environments.

Use `--profile <name>` for a profile other than `web`, and `--uninstall` to
remove the row.

## What it does

The bundle registers the same interception points OpenCode and Hermes use,
natively:

- `tools/pre-execute` — every tool call is scored before dispatch;
- `agent/pre-step` — incoming prompts;
- `tools/post-execute` — tool results;
- `agent/turn-stopping` — final responses (optional).

`actions: enforce` maps block/support to `deny`, review to `ask`, and uses the
same one-credit-per-evaluation service semantics.

## Verify

Restart the dsh profile, then run:

```bash
npx -y @codebam/eval-jev-guardrails doctor dsh --profile web
```

Ask the agent to run a destructive command; the tool call should be denied with
a Jev guardrails reason in the transcript.
