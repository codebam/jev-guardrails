/** Shared installer result types. @module @codebam/eval-jev-guardrails/install/types */

/** Change applied to one file during an install. */
export interface FileChange {
  path: string
  status: 'created' | 'updated' | 'unchanged'
  detail?: string
}

/** Result of one installer run. */
export interface InstallResult {
  harness: 'opencode' | 'hermes' | 'dsh'
  /** `project`, `global`, or `profile:<name>`. */
  scope: string
  /** Directory or manifest the installer targeted. */
  target: string
  /** True when at least one file was created or updated. */
  changed: boolean
  files: FileChange[]
  /** Non-fatal problems (for example `hermes plugins enable` returned non-zero). */
  warnings: string[]
  /** Actionable follow-up notes printed by the CLI. */
  notes: string[]
}

/** Error raised by an installer for an unusable target. */
export class InstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstallError'
  }
}
