/**
 * WebCrypto helpers shared by auth, admin bootstrap, and cache keys.
 *
 * Everything here uses web-standard `crypto.subtle`/`crypto.getRandomValues`
 * so the same code runs in workerd, Node 20+, and tests.
 */

/** Hex-encode bytes. */
function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** Base64url-encode bytes without padding. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** SHA-256 digest bytes of a UTF-8 string. */
export async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return new Uint8Array(digest)
}

/** SHA-256 hex digest of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  return toHex(await sha256Bytes(input))
}

/** Constant-time comparison of two strings (compared through SHA-256). */
export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Bytes(left), sha256Bytes(right)])
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  return diff === 0
}

/** A stable random id with a short kind prefix. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

/** Mint a new `eval_` bearer token and its display prefix. */
export function generateApiKey(): { token: string; prefix: string; hashPromise: Promise<string> } {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = `eval_${toBase64Url(bytes)}`
  return {
    token,
    prefix: `${token.slice(0, 12)}…`,
    hashPromise: sha256Hex(token),
  }
}
