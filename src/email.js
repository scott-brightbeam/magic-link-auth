// Address normalisation. Deliberately conservative: one '@', no whitespace,
// a dotted domain, RFC 5321 length cap. Lowercased so allowlists compare cleanly.

const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normaliseEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase()
  if (!email || email.length > 254 || !SHAPE.test(email)) return null
  if (email.split('@').length !== 2) return null
  return email
}

/** s***@ibec.ie — enough for the person to recognise, not enough to harvest. */
export function maskEmail(email) {
  const [local, domain] = String(email).split('@')
  if (!local || !domain) return '***'
  return `${local[0]}***@${domain}`
}
