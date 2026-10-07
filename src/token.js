// Token minting and hashing. Web Crypto only, so this runs unchanged on Bun,
// Node 20+, Deno and Cloudflare Workers.

const enc = new TextEncoder()

function toBase64Url(bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 32 random bytes, base64url — 256 bits of entropy. */
export function mintToken(byteLength = 32) {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes)
}

/** SHA-256 hex. Only the hash is ever stored, so a store leak yields no usable link. */
export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(String(token)))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time string compare for equal-length hex digests. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
