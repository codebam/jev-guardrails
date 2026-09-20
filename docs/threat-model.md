# Threat model and limitations

Eval Guardrails is a **risk-scoring and policy layer**, not a sandbox,
authorization boundary, or jailbreak-proof system. Read this before buying,
selling, or advertising it.

## What it protects against

- A model proposing a destructive, exfiltrating, remote-code, credential, or
  out-of-scope tool call by mistake.
- Prompt injection in fetched pages, issues, tool output, or documents.
- Policies that must be consistent across several agents and harnesses.
- Missing audit evidence for why an action was allowed, reviewed, or denied.
- A cheap second opinion before an action runs, at a few thousandths of a cent
  per evaluation.

## What it does not protect against

- **A model that controls its own configuration.** OpenCode plugins, Hermes
  plugins, and dsh bundles run in the same user process that owns the harness
  configuration. A capable agent with write access can edit the plugin,
  disable the bundle, remove the hook, or change the API key. The guardrail is
  a policy layer, not a tamper-proof control.
- **A tool call outside the hooked path.** A model can execute code through a
  different tool, write a script and run it later, use a network client
  directly, or chain tool calls in ways the surface does not expose as
  separate hooks.
- **A malicious operator.** The service scores the state it receives. An
  operator who controls the harness or service can bypass or falsify it.
- **Hard safety, legal, or compliance guarantees.** Probabilities are model
  output. Thresholds are a product policy. Jev can be wrong, and every
  classifier has false negatives.
- **A provider outage.** `failMode` decides whether an unreachable service
  allows, reviews, or blocks. `open` keeps the harness working but is not a
  safety guarantee.

## Recommended layering

Use these alongside, not instead of, hard controls:

1. OS/container sandboxing, read-only mounts, and resource limits.
2. User permissions and scoped credentials.
3. Human approval for high-consequence actions.
4. Eval Guardrails for fast, consistent, auditable risk scoring.
5. Audit logs and periodic review of verdicts and false positives.

## Operator hardening

- Install hooks in operator-owned paths that the agent cannot write, not in
  the project workspace.
- Keep the eval API key out of the agent's environment when possible.
- Set `failMode: closed` in environments where an unavailable guardrail must
  stop work.
- Use `--on-review deny` and low `severityBlock` only after measuring false
  positives on your own traffic.
- Treat `doctor` as a visibility check, not a tamper-proof attestation.

## Marketing wording

Acceptable: “scores tool calls before execution,” “applies a policy across
harnesses,” “flags prompt injection and risky actions,” “auditable decisions,”
“defense-in-depth.”

Avoid: “prevents jailbreaks,” “makes an agent safe,” “guarantees no harmful
actions,” “security boundary,” or “compliance-certified.”
