/** Installer entry points for OpenCode, Hermes Agent, and DeepSeek Harness. @module @codebam/eval-jev-guardrails/install */
export * from './types.js'
export { installOpenCode, openCodeConfigDir, renderOpenCodePluginSource } from './opencode.js'
export type { InstallOpenCodeOptions } from './opencode.js'
export { installHermes, hermesPluginsDir, hermesTemplateDir } from './hermes.js'
export type { InstallHermesOptions } from './hermes.js'
export { installDsh, listDshProfiles, renderDshPatchRow, resolveDshHome, resolveDshProfile } from './dsh.js'
export type { InstallDshOptions } from './dsh.js'
export { copyTemplateFile, findOnPath, upsertTopLevelYamlItem, updateJsonFile, writeTextIfChanged, yamlScalar } from './util.js'
