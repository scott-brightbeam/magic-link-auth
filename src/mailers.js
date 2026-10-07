// Mailer adapters. A mailer is any object with
//   async send({ to, subject, text, html }) → { id? }
// that throws on failure. Swap providers without touching the consumer.

/** Resend (https://resend.com) — one API key, HTTP only. `from` must be on a domain verified in Resend. */
export function resendMailer({ apiKey, from, replyTo, fetch: f = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('resendMailer: apiKey is required')
  if (!from) throw new Error('resendMailer: from is required')
  return {
    kind: 'resend',
    async send({ to, subject, text, html }) {
      const res = await f('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(`resend ${res.status}: ${body?.message ?? body?.name ?? 'send failed'}`)
      return { id: body.id ?? null }
    },
  }
}

/** Development: print the link instead of sending. Never use in production. */
export function consoleMailer({ log = console.log } = {}) {
  return {
    kind: 'console',
    async send({ to, subject, text }) {
      log(`[magic-link] to=${to} subject="${subject}"\n${text}`)
      return { id: null }
    },
  }
}

/** Tests: keep every message in `sent`. */
export function captureMailer() {
  const sent = []
  return {
    kind: 'capture',
    sent,
    async send(msg) { sent.push(msg); return { id: `capture-${sent.length}` } },
    lastLink() {
      const m = sent.at(-1)?.text.match(/https?:\/\/\S+/)
      return m ? m[0] : null
    },
  }
}
