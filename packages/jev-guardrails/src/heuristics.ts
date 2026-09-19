/**
 * Local fast paths.
 *
 * Jev is cheap enough for every ambiguous call, but not every call is
 * ambiguous. This module recognizes routine read-only commands, obvious
 * destructive ones, and writes that never leave the workspace so the model
 * call is spent on things a regex cannot safely decide.
 *
 * A local decision is deliberately conservative: when in doubt, return
 * `undefined` and let Jev decide.
 *
 * @module @codebam/jev-guardrails/heuristics
 */
import type { ActionDescriptor, LocalDecision } from './types.js'
import { isRecord, stableStringify } from './util.js'

/** Paths and names that suggest credentials, private keys, or agent state. */
const SENSITIVE_PATH =
  /(?:^|\/)(?:\.ssh|\.aws|\.azure|\.gnupg|\.config\/gcloud|\.kube|\.docker|\.netrc|\.git-credentials|\.npmrc|\.pypirc|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|wallet\.dat|\.env(?:$|\.)|\.envrc|keychain|login\.keychain)(?:\/|$)/i

/** Shell metacharacters that make a safe-looking command ambiguous. */
const SHELL_UNSAFE = /[;&|<>`]|\$\(|\$\{/

interface Rule {
  rule: string
  pattern: RegExp
  action: 'block' | 'review'
  reason: string
}

/** Patterns that are dangerous on their face. Checked before safe-path rules. */
const DANGEROUS_RULES: Rule[] = [
  {
    rule: 'remote-pipe-shell',
    pattern: /(?:curl|wget|fetch)\b[\s\S]{0,400}?\|\s*(?:sudo\s+)?(?:ba|z|da|k|c|fi)?sh\b/i,
    action: 'block',
    reason: 'pipes remotely fetched content directly into a shell',
  },
  {
    rule: 'remote-eval',
    pattern: /(?:eval|source|\.)\s*[("']*\s*\$(?:\(|\{)?\s*(?:curl|wget)\b/i,
    action: 'block',
    reason: 'executes remotely fetched content',
  },
  {
    rule: 'decoded-pipe-shell',
    pattern: /(?:base64\s+(?:-d|--decode)|openssl\s+enc)\b[\s\S]{0,300}?\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
    action: 'block',
    reason: 'decodes and pipes content into a shell',
  },
  {
    rule: 'fork-bomb',
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    action: 'block',
    reason: 'matches a fork bomb',
  },
  {
    rule: 'disk-overwrite',
    pattern: /(?:dd\b[^\n]{0,200}\bof=\/dev\/|\bof=\/dev\/(?:sd|nvme|vd|hd|disk)|>\s*\/dev\/(?:sd|nvme|vd|hd|disk))/i,
    action: 'block',
    reason: 'writes directly to a block device',
  },
  {
    rule: 'filesystem-destroy',
    pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs|fdisk|parted|sgdisk)\b/i,
    action: 'block',
    reason: 'formats or repartitions a filesystem',
  },
  {
    rule: 'catastrophic-rm',
    pattern: /\brm\b(?=[^\n]{0,120}(?:\s-rf|\s-fr|\s-r\s+-f|\s-f\s+-r))[^\n]{0,120}(?:\s\/|\s~\s|\s~$|\s\.\s|\s\.$|\s\.\.\s|\s\.\.$|\s\*\s|\s\*$|\$HOME|\$\{HOME\})/i,
    action: 'block',
    reason: 'recursively deletes a root, home, current, parent, wildcard, or $HOME target',
  },
  {
    rule: 'security-disable',
    pattern: /\b(?:iptables\s+-F|ufw\s+disable|setenforce\s+0|spctl\s+--master-disable|csrutil\s+disable|systemctl\s+(?:stop|disable|mask)\s+(?:firewalld|ufw|apparmor|selinux)|chmod\s+-R\s+777\s+\/)/i,
    action: 'block',
    reason: 'disables or weakens a system security control',
  },
  {
    rule: 'power-control',
    pattern: /\b(?:shutdown|reboot|poweroff|halt|init\s+0)\b/i,
    action: 'block',
    reason: 'shuts down or reboots the machine',
  },
  {
    rule: 'privilege-escalation',
    pattern: /^(?:sudo|doas)\b/i,
    action: 'review',
    reason: 'runs with elevated privileges',
  },
  {
    rule: 'force-push',
    pattern: /\bgit\s+push\b[^\n]{0,120}(?:--force(?:-with-lease)?|-f)\b/i,
    action: 'review',
    reason: 'force-pushes and can rewrite remote history',
  },
  {
    rule: 'hard-reset',
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f[a-z]*d?x?|checkout\s+--\s+\.)\b/i,
    action: 'review',
    reason: 'discards uncommitted work',
  },
  {
    rule: 'publish',
    pattern: /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\bgh\s+release\s+create\b/i,
    action: 'review',
    reason: 'publishes a package or release externally',
  },
  {
    rule: 'production-deploy',
    pattern: /\b(?:wrangler\s+deploy|vercel\b[^\n]{0,80}--prod|netlify\s+deploy|fly(?:ctl)?\s+deploy|heroku\s+(?:deploy|releases)|kubectl\s+(?:apply|delete|rollout)|terraform\s+(?:apply|destroy)|pulumi\s+(?:up|destroy))\b/i,
    action: 'review',
    reason: 'deploys, publishes, or destroys external infrastructure',
  },
  {
    rule: 'destructive-sql',
    pattern: /\b(?:drop\s+table|truncate\s+table|delete\s+from\b[^\n]{0,100}\bwhere\s+1\s*=\s*1)\b/i,
    action: 'review',
    reason: 'destroys database data',
  },
  {
    rule: 'history-wipe',
    pattern: /\b(?:history\s+-c|rm\b[^\n]{0,80}(?:\.bash_history|\.zsh_history|\.python_history))\b/i,
    action: 'review',
    reason: 'erases shell history',
  },
]

/** Commands that only observe and are safe with ordinary flags. */
const SAFE_EXACT = new Set([
  'pwd', 'whoami', 'date', 'uname', 'hostname', 'uptime', 'true', 'false',
  'ls', 'dir', 'tree', 'printf', 'echo', 'which',
])

const GIT_SAFE = [
  /^git\s+status(?:\s|$)/,
  /^git\s+diff(?:\s|$)/,
  /^git\s+log(?:\s|$)/,
  /^git\s+show(?:\s|$)/,
  /^git\s+rev-parse(?:\s|$)/,
  /^git\s+ls-files(?:\s|$)/,
  /^git\s+blame(?:\s|$)/,
  /^git\s+describe(?:\s|$)/,
  /^git\s+shortlog(?:\s|$)/,
  /^git\s+whatchanged(?:\s|$)/,
  /^git\s+branch\s*$/,
  /^git\s+branch\s+(?:-a|-r|-v|-vv|--list[^\n]*|--show-current|--contains[^\n]*)$/,
  /^git\s+remote\s*$/,
  /^git\s+remote\s+(?:-v|--verbose|show[^\n]*|get-url[^\n]*)$/,
  /^git\s+tag\s*$/,
  /^git\s+tag\s+(?:-l[^\n]*|--list[^\n]*)$/,
  /^git\s+worktree\s+list(\s|$)/,
]

const PROJECT_SAFE = [
  /^(?:npm|pnpm|yarn)\s+(?:test|build|lint|typecheck|check|run\s+(?:test|lint|typecheck|check|build))(?:\s|$)/,
  /^node\s+--test(?:\s|$)/,
  /^(?:npx\s+)?(?:vitest|jest)\s+(?:run|--run)(?:\s|$)/,
  /^(?:python[0-9.]*\s+-m\s+)?pytest(?:\s|$)/,
  /^cargo\s+(?:test|check|build|clippy|fmt)(?:\s|$)/,
  /^go\s+(?:test|build|vet)(?:\s|$)/,
  /^tsc(?:\s|$)/,
  /^nix\s+(?:build|flake\s+(?:check|show)|eval|fmt)(?:\s|$)/,
  /^make\s+(?:test|check)(?:\s|$)/,
  /^just\s+(?:test|check)(?:\s|$)/,
  /^ruff\s+check(?:\s|$)/,
]

const READER_COMMANDS = new Set([
  'cat', 'head', 'tail', 'wc', 'stat', 'file', 'less', 'more', 'nl', 'sort', 'uniq',
  'cut', 'tr', 'jq', 'yq', 'rg', 'grep', 'fd', 'find', 'sed', 'awk', 'column',
])

/** Commands whose presence means a `find`/`sed`/`awk` invocation is not read-only. */
const EXECUTING_FLAGS = /(?:-exec(?:dir)?|-delete|-ok(?:dir)?|-fls|-fprintf)\b|--in-place\b|-i\b|system\s*\(|[|>]/i

/** Classify one shell command line, or `undefined` when Jev should decide. */
export function classifyShellCommand(command: string, workspace?: string): LocalDecision | undefined {
  const trimmed = command.trim()
  if (trimmed.length === 0) return { action: 'allow', rule: 'empty-command', reason: 'empty command' }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length > 1) return classifyCommandJoin(lines, workspace)

  const joined = trimmed.split(/\s*&&\s*/)
  if (joined.length > 1) return classifyCommandJoin(joined, workspace)

  if (SHELL_UNSAFE.test(joined[0] ?? '')) {
    // Pipes and redirection are opaque to a local fast path except for the
    // explicit dangerous patterns above.
    for (const rule of DANGEROUS_RULES) if (rule.pattern.test(joined[0] ?? '')) return { action: rule.action, rule: rule.rule, reason: rule.reason }
    return undefined
  }

  for (const rule of DANGEROUS_RULES) {
    if (rule.pattern.test(joined[0] ?? '')) return { action: rule.action, rule: rule.rule, reason: rule.reason }
  }

  const single = joined[0] ?? ''
  if (hasSensitivePath(single, workspace)) return undefined
  if (GIT_SAFE.some((pattern) => pattern.test(single))) return { action: 'allow', rule: 'safe-git-command', reason: 'read-only git query' }
  if (PROJECT_SAFE.some((pattern) => pattern.test(single))) return { action: 'allow', rule: 'project-test-or-build', reason: 'routine project test/build command' }

  const first = firstWord(single)
  if (first === undefined) return undefined
  if (SAFE_EXACT.has(first)) return { action: 'allow', rule: 'safe-query-command', reason: `routine ${first} query` }
  if (READER_COMMANDS.has(first)) {
    if (first === 'find' && EXECUTING_FLAGS.test(single)) return undefined
    if (first === 'sed' && EXECUTING_FLAGS.test(single)) return undefined
    if (first === 'awk' && EXECUTING_FLAGS.test(single)) return undefined
    return { action: 'allow', rule: 'safe-read-command', reason: `routine ${first} read` }
  }
  return undefined
}

function classifyCommandJoin(parts: string[], workspace: string | undefined): LocalDecision | undefined {
  const decisions: LocalDecision[] = []
  for (const part of parts) {
    const decision = classifyShellCommand(part, workspace)
    if (decision === undefined) return undefined
    decisions.push(decision)
  }
  const blocked = decisions.find((decision) => decision.action === 'block')
  if (blocked) return blocked
  const review = decisions.find((decision) => decision.action === 'review')
  if (review) return review
  return decisions[0]
}

function firstWord(command: string): string | undefined {
  const match = command.match(/^\s*(?:sudo\s+)?([A-Za-z0-9_./-]+)/)
  if (match?.[1] === undefined) return undefined
  return match[1].split('/').pop()
}

/** True when a command contains a sensitive path or escapes the workspace with `..`. */
function hasSensitivePath(command: string, workspace?: string): boolean {
  for (const token of command.split(/\s+/)) {
    const bare = token.replace(/^['"]|['"]$/g, '')
    if (SENSITIVE_PATH.test(bare)) return true
    if (bare.includes('/../') || bare.startsWith('../')) return true
    if (workspace !== undefined && bare.startsWith('/') && !isInside(workspace, bare)) return true
  }
  return false
}

function isInside(workspace: string, candidate: string): boolean {
  const root = workspace.endsWith('/') ? workspace.slice(0, -1) : workspace
  const path = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate
  return path === root || path.startsWith(`${root}/`)
}

type ToolFamily = 'shell' | 'read' | 'write' | 'fetch' | 'unknown'

function toolFamily(name: string): ToolFamily {
  const n = name.toLowerCase()
  if (/^(bash|sh|zsh|nu|nushell|pwsh|powershell|cmd|shell|exec|execute|terminal|run_code)$/.test(n)) return 'shell'
  if (/(?:^|_)(?:bash|shell|sh)$/.test(n)) return 'shell'
  if (/^(?:web_?fetch|fetch|http|curl|wget|browser|read_url|web_search|websearch)/.test(n)) return 'fetch'
  if (/^(?:read|view|list|glob|grep|rg|search|stat|ls|cat|head|tail|job_output|job_list)/.test(n)) return 'read'
  if (/(?:^|_)(?:read|view|list|glob|grep|search)$/.test(n)) return 'read'
  if (/^(?:write|edit|create|delete|move|copy|mkdir|rm|str_replace|apply_patch|patch|replace)/.test(n)) return 'write'
  if (/(?:^|_)(?:write|edit|create|delete|move|patch)$/.test(n)) return 'write'
  return 'unknown'
}

/** Extract the shell source from common tool argument shapes. */
function shellSource(args: unknown): string | undefined {
  if (typeof args === 'string') return args
  if (!isRecord(args)) return undefined
  for (const key of ['command', 'cmd', 'script', 'code', 'source', 'input']) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/** Argument keys whose string value names a file or directory. */
const PATH_KEYS = /^(?:path|paths|file|files|filename|filepath|file_path|target|dest|destination|source|old_?path|new_?path|dir|directory|cwd|workdir)$/i

/** Collect path-like strings from arbitrary tool arguments. */
function collectPathCandidates(args: unknown): string[] {
  const out: string[] = []
  visit(args, '')
  return out

  function visit(value: unknown, key: string): void {
    if (typeof value === 'string') {
      if (PATH_KEYS.test(key) || looksLikePath(value)) out.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key)
      return
    }
    if (isRecord(value)) {
      for (const [entryKey, entry] of Object.entries(value)) visit(entry, entryKey)
    }
  }
}

function escapesRelative(value: string): boolean {
  return value.startsWith('../') || value.includes('/../') || value === '..'
}

function looksLikePath(value: string): boolean {
  if (value.length === 0 || value.includes('\n')) return false
  if (SENSITIVE_PATH.test(value)) return true
  return value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Classify one proposed action from local rules alone.
 * @returns a decision, or `undefined` when the action should go to Jev.
 */
export function classifyActionLocally(action: ActionDescriptor): LocalDecision | undefined {
  const family = toolFamily(action.tool)
  if (family === 'shell') {
    const command = shellSource(action.arguments)
    if (command === undefined) return undefined
    return classifyShellCommand(command, action.workspace ?? action.cwd)
  }

  if (family === 'fetch') return { action: 'allow', rule: 'read-only-network-tool', reason: 'network read tool; its output is screened separately' }

  if (family === 'read') {
    const candidates = collectPathCandidates(action.arguments)
    for (const candidate of candidates) {
      if (SENSITIVE_PATH.test(candidate)) return undefined
      if (escapesRelative(candidate)) return undefined
      if (candidate.startsWith('/') && action.workspace !== undefined && !isInside(action.workspace, candidate)) return undefined
    }
    return { action: 'allow', rule: 'read-only-tool', reason: `read-only ${action.tool} call` }
  }

  if (family === 'write') {
    const candidates = collectPathCandidates(action.arguments)
    if (candidates.length === 0) return undefined
    for (const candidate of candidates) {
      if (SENSITIVE_PATH.test(candidate)) {
        return { action: 'review', rule: 'sensitive-write-path', reason: `write targets a sensitive path: ${candidate}` }
      }
      if (escapesRelative(candidate) || (candidate.startsWith('/') && action.workspace !== undefined && !isInside(action.workspace, candidate))) {
        return { action: 'review', rule: 'write-outside-workspace', reason: `write targets a path outside the workspace: ${candidate}` }
      }
    }
    return { action: 'allow', rule: 'workspace-write', reason: `write stays inside the workspace` }
  }

  return undefined
}

interface InjectionRule {
  rule: string
  pattern: RegExp
}

const INJECTION_RULES: InjectionRule[] = [
  { rule: 'instruction-override', pattern: /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,60}?\b(?:previous|prior|above|earlier|all|any)\b[\s\S]{0,30}?\b(?:instructions?|prompts?|rules?)\b/i },
  { rule: 'new-system-prompt', pattern: /\b(?:you are now|from now on|new (?:system )?(?:prompt|instructions?|rules?)|system prompt|developer message|act as (?:an? )?(?:AI|assistant))\b/i },
  { rule: 'role-tags', pattern: /<\/?(?:system|assistant|developer|user|instructions?)>|\[(?:system|assistant|developer|instruction)s?\]/i },
  { rule: 'remote-pipe', pattern: /\b(?:curl|wget)\b[^\n]{0,160}?\|\s*(?:sudo\s+)?(?:ba|z|da|k|c)?sh\b/i },
  { rule: 'data-exfiltration', pattern: /\b(?:exfiltrate|send|post|upload|transmit)\b[\s\S]{0,100}?\b(?:secret|token|key|password|credential|\.env|ssh|wallet|private)/i },
  { rule: 'destructive-directive', pattern: /\b(?:rm\s+-rf|drop\s+table|truncate\s+table|delete\s+all|wipe\s+the)\b/i },
  { rule: 'hidden-characters', pattern: /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/ },
  { rule: 'do-not-tell', pattern: /\b(?:do not|don't|never)\s+(?:tell|inform|mention|reveal)\b[\s\S]{0,40}?\b(?:user|human|operator|anyone)\b/i },
  { rule: 'credential-material', pattern: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY)\b/ },
]

/**
 * Cheap check used to decide whether untrusted text deserves a Jev call.
 * A false positive costs one cheap request; a false negative would leave
 * untrusted instructions unscreened, so the rules are broad on purpose.
 */
export function looksLikeInjection(text: string): { suspicious: boolean; matches: string[] } {
  const matches: string[] = []
  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(text)) matches.push(rule.rule)
  }
  return { suspicious: matches.length > 0, matches }
}

/** Debug helper used by the tests and by plugin logs. */
export function describeAction(action: ActionDescriptor): string {
  const args = typeof action.arguments === 'string' ? action.arguments : stableStringify(action.arguments)
  return `${action.tool}(${args.length > 240 ? `${args.slice(0, 240)}…` : args})`
}
