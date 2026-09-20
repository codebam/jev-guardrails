/** Small idempotent file/YAML helpers shared by the installers. @module @codebam/eval-jev-guardrails/install/util */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileChange } from './types.js'
import { InstallError } from './types.js'

/** Write a text file only when its content differs; reports created/updated/unchanged. */
export function writeTextIfChanged(path: string, content: string, mode = 0o644): FileChange {
  const next = content.endsWith('\n') ? content : `${content}\n`
  const existed = existsSync(path)
  if (existed) {
    try {
      if (readFileSync(path, 'utf8') === next) return { path, status: 'unchanged' }
    } catch (error) {
      throw new InstallError(`could not read ${path}: ${errorMessage(error)}`)
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, next, { mode })
  return { path, status: existed ? 'updated' : 'created' }
}

/** Read a JSON object file, or `{}` when it does not exist. */
export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new InstallError(`refusing to edit ${path}: it is not valid JSON (${errorMessage(error)})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InstallError(`refusing to edit ${path}: expected a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/** Merge an updated object into a JSON file, preserving unrelated keys. */
export function updateJsonFile(
  path: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): FileChange {
  const current = readJsonObject(path)
  const existed = existsSync(path)
  const next = update(current)
  const content = `${JSON.stringify(next, null, 2)}\n`
  if (existed) {
    try {
      if (readFileSync(path, 'utf8') === content) return { path, status: 'unchanged' }
    } catch (error) {
      throw new InstallError(`could not read ${path}: ${errorMessage(error)}`)
    }
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode: 0o644 })
  return { path, status: existed ? 'updated' : 'created' }
}

/** Copy a template file, replacing an optional version marker, idempotently. */
export function copyTemplateFile(
  sourcePath: string,
  targetPath: string,
  transform: (content: string) => string = (content) => content,
): FileChange {
  let content: string
  try {
    content = readFileSync(sourcePath, 'utf8')
  } catch (error) {
    throw new InstallError(`could not read the bundled template ${sourcePath}: ${errorMessage(error)}`)
  }
  return writeTextIfChanged(targetPath, transform(content))
}

/** List regular files in a template directory. */
export function templateFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    throw new InstallError(`could not read the bundled template directory ${directory}: ${errorMessage(error)}`)
  }
}

/**
 * Insert or replace one top-level YAML list item identified by its `id:`.
 *
 * The rest of the file is preserved byte-for-byte outside the replaced item,
 * including comments and blank lines after the item's content.
 */
export function upsertTopLevelYamlItem(
  source: string,
  id: string,
  renderItem: () => string[],
): { text: string; changed: boolean } {
  const item = renderItem()
  if (item.length === 0) throw new InstallError('upsertTopLevelYamlItem requires a non-empty item')
  const lines = source.split(/\r?\n/)
  const starts: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^-(?:\s|$)/.test(lines[index] ?? '')) starts.push(index)
  }

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i] ?? 0
    const end = starts[i + 1] ?? lines.length
    const block = lines.slice(start, end)
    if (blockItemId(block) !== id) continue
    // Keep trailing blank/comment lines that visually belong to the next item.
    let tailStart = block.length
    while (tailStart > 0) {
      const line = block[tailStart - 1] ?? ''
      if (line.trim().length === 0 || line.trimStart().startsWith('#')) tailStart -= 1
      else break
    }
    // Replace the meaningful part of the block (from the `- ` line through the
    // last content line) with the canonical item, keeping any trailing trivia.
    const canonical = item.join('\n').split('\n')
    const tail = block.slice(tailStart)
    const replacement = [...canonical, ...tail]
    if (sameLines(block, replacement)) return { text: source, changed: false }
    const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end)]
    return { text: joinLines(next), changed: true }
  }

  // No matching item: drop a bare `[]` document marker, then append.
  const withoutEmptyArray = lines.filter((line) => line.trim() !== '[]')
  const content = trimTrailingEmpty(withoutEmptyArray)
  const next = [...content]
  if (next.length > 0 && (next[next.length - 1] ?? '').trim().length > 0) next.push('')
  next.push(...item)
  return { text: joinLines(next), changed: true }
}

function blockItemId(block: string[]): string | undefined {
  for (const line of block) {
    const match = /^\s*(?:-\s*)?id:\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    return stripQuotes(match[1] ?? '')
  }
  return undefined
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function trimTrailingEmpty(lines: string[]): string[] {
  const next = [...lines]
  while (next.length > 0 && (next[next.length - 1] ?? '').trim().length === 0) next.pop()
  return next
}

function joinLines(lines: string[]): string {
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/** Quote a YAML scalar when it is not a safe plain value. */
export function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value) && !value.includes('#')) return value
  return `'${value.replace(/'/g, "''")}'`
}

/** Resolve a binary on the provided PATH without spawning it. */
export function findOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? ''
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const directory of pathValue.split(separator)) {
    if (directory.length === 0) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${binary}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
