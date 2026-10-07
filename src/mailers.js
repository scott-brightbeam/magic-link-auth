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

/**
 * Cloudflare Email Service, REST API — for apps that are not Cloudflare Workers.
 * `from` must be on a domain onboarded for Email Sending in that account
 * (`wrangler email sending list`). The token needs the Email Sending permission.
 * Sending to arbitrary recipients needs the Workers Paid plan; on Free, only
 * verified destination addresses are accepted (error 10105 not_entitled).
 */
export function cloudflareMailer({ accountId, apiToken, from, fromName, replyTo, fetch: f = globalThis.fetch } = {}) {
  if (!accountId) throw new Error('cloudflareMailer: accountId is required')
  if (!apiToken) throw new Error('cloudflareMailer: apiToken is required')
  if (!from) throw new Error('cloudflareMailer: from is required')
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`
  return {
    kind: 'cloudflare',
    async send({ to, subject, text, html }) {
      const res = await f(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to, subject, text, html,
          from: fromName ? { address: from, name: fromName } : from,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body?.success === false) {
        const e = body?.errors?.[0]
        throw new Error(`cloudflare ${res.status}: ${e ? `${e.code} ${e.message}` : 'send failed'}`)
      }
      const r = body?.result ?? {}
      if ((r.permanent_bounces ?? []).length) throw new Error(`cloudflare: permanent bounce for ${r.permanent_bounces.join(', ')}`)
      return { id: null, delivered: r.delivered ?? [], queued: r.queued ?? [] }
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
