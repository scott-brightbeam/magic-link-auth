// @brightbeam/magic-link — the link lifecycle and nothing else.
//
// The consumer keeps its own session, allowlist and roles. This module:
//   GET  {base}           a plain sign-in form (for apps without their own UI)
//   POST {base}/request   email in → link sent if allowed; the reply never says which
//   GET  {base}/confirm   shows a "Sign in" button; changes NOTHING (mail scanners prefetch GETs)
//   POST {base}/redeem    single-use exchange → onRedeemed() issues the consumer's session
//
// Handlers take a standard Fetch `Request` and return a `Response`, so they mount on
// Hono, Bun.serve, Workers, Next route handlers or anything else that speaks Fetch.

import { mintToken, hashToken, safeEqual } from './token.js'
import { normaliseEmail, maskEmail } from './email.js'
import * as defaultTemplates from './templates.js'

const MINUTE = 60 * 1000
const GENERIC_MESSAGE = 'If that address has access, a sign-in link is on its way. It expires in {m} minutes.'
const BIND_COOKIE = 'ml_requester'

function required(o, key, type) {
  if (typeof o[key] !== type) throw new Error(`createMagicLink: \`${key}\` (${type}) is required`)
}

export function defaultClientIp(request) {
  const h = request.headers
  return h.get('fly-client-ip') || h.get('cf-connecting-ip') ||
    (h.get('x-forwarded-for') || '').split(',')[0].trim() || h.get('x-real-ip') || 'unknown'
}

export function createMagicLink(options = {}) {
  const o = options
  required(o, 'appName', 'string')
  required(o, 'isAllowed', 'function')
  required(o, 'onRedeemed', 'function')
  if (!o.store) throw new Error('createMagicLink: `store` is required')
  if (!o.mailer || typeof o.mailer.send !== 'function') throw new Error('createMagicLink: `mailer` with send() is required')
  if (!o.publicOrigin) throw new Error('createMagicLink: `publicOrigin` is required — never derive links from the Host header')

  const basePath = (o.basePath ?? '/auth/magic').replace(/\/+$/, '')
  const ttlMs = (o.ttlSeconds ?? 15 * 60) * 1000
  const minutes = Math.round(ttlMs / MINUTE)
  const minResponseMs = o.minResponseMs ?? 400
  const limits = {
    email: { max: 3, windowMs: 15 * MINUTE, ...(o.rateLimits?.perEmail ?? {}) },
    ip: { max: 20, windowMs: 60 * MINUTE, ...(o.rateLimits?.perIp ?? {}) },
  }
  const successRedirect = o.successRedirect ?? '/'
  const bindToRequester = o.bindToRequester === true
  const now = o.now ?? (() => Date.now())
  const sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const getClientIp = o.getClientIp ?? defaultClientIp
  const tpl = { ...defaultTemplates, ...(o.templates ?? {}) }
  const pending = new Set()

  function origin() {
    const raw = typeof o.publicOrigin === 'function' ? o.publicOrigin() : o.publicOrigin
    const u = new URL(raw)
    return u.origin
  }
  const secureCookie = () => origin().startsWith('https://')

  async function emit(type, fields = {}) {
    if (!o.onEvent) return
    try {
      const emailHash = fields.email ? (await hashToken(fields.email)).slice(0, 16) : undefined
      await o.onEvent({ type, at: new Date(now()).toISOString(), ...fields, emailHash })
    } catch { /* an audit sink must never break sign-in */ }
  }

  const html = (body, status = 200, extra = {}) => new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      ...extra,
    },
  })
  const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  })

  function isForm(request) {
    const ct = request.headers.get('content-type') || ''
    return ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')
  }
  async function readField(request, name) {
    try {
      if (isForm(request)) return (await request.formData()).get(name)
      const body = await request.json()
      return body?.[name]
    } catch { return null }
  }
  function readCookie(request, name) {
    const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
    return m ? decodeURIComponent(m[1]) : null
  }
  function bindCookie(value, maxAgeSec) {
    return [`${BIND_COOKIE}=${value}`, 'HttpOnly', `Path=${basePath}`, `Max-Age=${maxAgeSec}`, 'SameSite=Lax',
      ...(secureCookie() ? ['Secure'] : [])].join('; ')
  }

  function track(promise) {
    pending.add(promise)
    promise.finally(() => pending.delete(promise))
    if (typeof o.waitUntil === 'function') o.waitUntil(promise)
  }

  // ---- GET {base} -------------------------------------------------------------
  async function handleSignInPage() {
    return html(tpl.requestForm({ appName: o.appName, actionPath: `${basePath}/request` }))
  }

  // ---- POST {base}/request ----------------------------------------------------
  async function handleRequest(request) {
    const started = now()
    const form = isForm(request)
    const email = normaliseEmail(await readField(request, 'email'))
    const ip = getClientIp(request)

    if (!email) {
      await emit('rejected', { reason: 'invalid-email', ip })
      return form
        ? html(tpl.requestForm({ appName: o.appName, actionPath: `${basePath}/request` }), 400)
        : json({ ok: false, error: 'invalid_email' }, 400)
    }

    const headers = {}
    // Everything up to (but not including) the mail send is awaited on BOTH paths,
    // then the reply is padded to a floor — the allowed and refused paths look the same.
    try {
      const ipCount = await o.store.hit(`ip:${ip}`, started, limits.ip.windowMs)
      const emailCount = await o.store.hit(`email:${email}`, started, limits.email.windowMs)
      if (ipCount > limits.ip.max || emailCount > limits.email.max) {
        await emit('suppressed', { reason: 'rate-limit', email, ip })
      } else if (!(await o.isAllowed(email))) {
        await emit('suppressed', { reason: 'not-allowed', email, ip })
      } else {
        const token = mintToken()
        const rec = { hash: await hashToken(token), email, createdAt: started, expiresAt: started + ttlMs, requesterHash: null }
        if (bindToRequester) {
          const nonce = mintToken()
          rec.requesterHash = await hashToken(nonce)
          headers['Set-Cookie'] = bindCookie(nonce, Math.ceil(ttlMs / 1000))
        }
        await o.store.supersede(email, started)
        await o.store.insertToken(rec)
        const link = `${origin()}${basePath}/confirm?token=${encodeURIComponent(token)}`
        const msg = tpl.email({ appName: o.appName, link, minutes })
        const send = o.mailer.send({ to: email, ...msg })
          .then(r => emit('sent', { email, ip, providerId: r?.id ?? null }))
          .catch(err => emit('send-failed', { email, ip, reason: String(err?.message ?? err) }))
        track(send)
        await emit('requested', { email, ip })
      }
    } catch (err) {
      // A store outage must not become an oracle either: same reply, loud event.
      await emit('error', { stage: 'request', email, ip, reason: String(err?.message ?? err) })
    }

    const elapsed = now() - started
    if (elapsed < minResponseMs) await sleep(minResponseMs - elapsed)

    const message = GENERIC_MESSAGE.replace('{m}', String(minutes))
    return form
      ? html(tpl.checkEmail({ appName: o.appName, message }), 200, headers)
      : json({ ok: true, message }, 202, headers)
  }

  async function lookup(token) {
    if (!token || typeof token !== 'string' || token.length > 200) return null
    const hash = await hashToken(token)
    const rec = await o.store.getToken(hash)
    if (!rec) return null
    const t = now()
    if (rec.usedAt != null || rec.supersededAt != null || rec.expiresAt <= t) return null
    return rec
  }

  const invalidPage = (status = 400) =>
    html(tpl.invalid({ appName: o.appName, requestPath: `${basePath}/request` }), status)

  // ---- GET {base}/confirm -----------------------------------------------------
  // Read-only by design. Outlook Safe Links and mail gateways fetch every link in an
  // email; if this consumed the token, the person's own click would always fail.
  async function handleConfirm(request) {
    const token = new URL(request.url).searchParams.get('token')
    const rec = await lookup(token)
    const ip = getClientIp(request)
    if (!rec) {
      await emit('rejected', { reason: 'invalid-token', stage: 'confirm', ip })
      return invalidPage()
    }
    await emit('confirm-viewed', { email: rec.email, ip })
    return html(tpl.confirm({ appName: o.appName, maskedEmail: maskEmail(rec.email), token, actionPath: `${basePath}/redeem` }))
  }

  // ---- POST {base}/redeem -----------------------------------------------------
  async function handleRedeem(request) {
    const ip = getClientIp(request)
    const reqOrigin = request.headers.get('origin')
    if (reqOrigin && reqOrigin !== 'null' && reqOrigin !== origin()) {
      await emit('rejected', { reason: 'bad-origin', ip, origin: reqOrigin })
      return html(tpl.invalid({ appName: o.appName, requestPath: `${basePath}/request` }), 403)
    }

    const token = await readField(request, 'token')
    const rec = await lookup(typeof token === 'string' ? token : null)
    if (!rec) {
      await emit('rejected', { reason: 'invalid-token', stage: 'redeem', ip })
      return invalidPage()
    }

    if (bindToRequester) {
      const nonce = readCookie(request, BIND_COOKIE)
      const ok = nonce && rec.requesterHash && safeEqual(await hashToken(nonce), rec.requesterHash)
      if (!ok) {
        await emit('rejected', { reason: 'wrong-browser', email: rec.email, ip })
        return invalidPage(403)
      }
    }

    // Access can be withdrawn between request and redeem; an outstanding link dies with it.
    if (!(await o.isAllowed(rec.email))) {
      await emit('rejected', { reason: 'no-longer-allowed', email: rec.email, ip })
      return invalidPage(403)
    }

    if (!(await o.store.consumeToken(rec.hash, now()))) {
      await emit('rejected', { reason: 'race-lost', email: rec.email, ip })
      return invalidPage()
    }

    let result
    try {
      result = (await o.onRedeemed({ email: rec.email, request })) ?? {}
    } catch (err) {
      await emit('error', { stage: 'onRedeemed', email: rec.email, ip, reason: String(err?.message ?? err) })
      return invalidPage(500)
    }

    const headers = new Headers({ Location: result.redirectTo ?? successRedirect, 'Cache-Control': 'no-store' })
    for (const [k, v] of result.headers ? new Headers(result.headers) : []) {
      if (k.toLowerCase() !== 'set-cookie') headers.set(k, v)
    }
    for (const c of [result.setCookie ?? []].flat()) headers.append('Set-Cookie', c)
    if (bindToRequester) headers.append('Set-Cookie', bindCookie('', 0))
    await emit('redeemed', { email: rec.email, ip })
    return new Response(null, { status: 303, headers })
  }

  return {
    basePath,
    handleSignInPage,
    handleRequest,
    handleConfirm,
    handleRedeem,
    /** Resolves when every in-flight email send has settled — tests and graceful shutdown. */
    settled: () => Promise.all([...pending]),
  }
}
