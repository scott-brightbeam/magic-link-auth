import { describe, test, expect } from 'bun:test'
import { createClient } from '@libsql/client'
import { Hono } from 'hono'
import { createMagicLink, memoryStore, libsqlStore, captureMailer, hashToken, normaliseEmail, maskEmail } from '../src/index.js'
import { mountMagicLink } from '../src/adapters/hono.js'

const ORIGIN = 'https://app.example.com'
const ALLOWED = 'guest@client.ie'

function setup(overrides = {}) {
  let clock = 1_800_000_000_000
  const allow = new Set([ALLOWED])
  const mailer = captureMailer()
  const store = overrides.store ?? memoryStore()
  const events = []
  const ml = createMagicLink({
    appName: 'Test App',
    publicOrigin: ORIGIN,
    isAllowed: async e => allow.has(e),
    store,
    mailer,
    onRedeemed: async ({ email }) => ({ setCookie: `session=${email}; Path=/; HttpOnly` }),
    onEvent: e => events.push(e),
    now: () => clock,
    sleep: async () => {},
    ...overrides,
  })
  return { ml, mailer, store, events, allow, tick: ms => { clock += ms } }
}

const jsonReq = (path, body, headers = {}) => new Request(`${ORIGIN}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})
const formReq = (path, fields, headers = {}) => new Request(`${ORIGIN}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString(),
})
const tokenOf = link => new URL(link).searchParams.get('token')

async function requestLink(t, email = ALLOWED, headers) {
  const res = await t.ml.handleRequest(jsonReq('/auth/magic/request', { email }, headers))
  await t.ml.settled()
  return res
}

describe('request', () => {
  test('allowed and refused addresses get byte-identical replies', async () => {
    const t = setup()
    const a = await requestLink(t, ALLOWED)
    const b = await requestLink(t, 'stranger@nowhere.com')
    expect(a.status).toBe(202)
    expect(b.status).toBe(202)
    expect(await a.text()).toBe(await b.text())
    expect(t.mailer.sent.length).toBe(1)
    expect(t.mailer.sent[0].to).toBe(ALLOWED)
    expect(t.events.find(e => e.type === 'suppressed').reason).toBe('not-allowed')
  })

  test('address is normalised before the allowlist check', async () => {
    const t = setup()
    await requestLink(t, '  GUEST@Client.IE ')
    expect(t.mailer.sent.length).toBe(1)
  })

  test('malformed address is a 400 that reveals nothing about the allowlist', async () => {
    const t = setup()
    const res = await requestLink(t, 'not-an-email')
    expect(res.status).toBe(400)
    expect(t.mailer.sent.length).toBe(0)
  })

  test('the link uses publicOrigin, never the Host header', async () => {
    const t = setup()
    await t.ml.handleRequest(jsonReq('/auth/magic/request', { email: ALLOWED }, { host: 'evil.example', 'x-forwarded-host': 'evil.example' }))
    await t.ml.settled()
    expect(t.mailer.lastLink().startsWith(`${ORIGIN}/auth/magic/confirm?token=`)).toBe(true)
  })

  test('the raw token is never stored', async () => {
    const t = setup()
    await requestLink(t)
    const token = tokenOf(t.mailer.lastLink())
    expect(t.store.dump()).not.toContain(token)
    expect(t.store.dump()).toContain(await hashToken(token))
  })

  test('per-email rate limit sends nothing more and the reply does not change', async () => {
    const t = setup()
    const bodies = []
    for (let i = 0; i < 5; i++) bodies.push(await (await requestLink(t)).text())
    expect(new Set(bodies).size).toBe(1)
    expect(t.mailer.sent.length).toBe(3)
    expect(t.events.some(e => e.type === 'suppressed' && e.reason === 'rate-limit')).toBe(true)
  })

  test('per-IP rate limit', async () => {
    const t = setup({ rateLimits: { perIp: { max: 2 } } })
    t.allow.add('b@client.ie'); t.allow.add('c@client.ie')
    for (const e of [ALLOWED, 'b@client.ie', 'c@client.ie']) await requestLink(t, e, { 'fly-client-ip': '9.9.9.9' })
    expect(t.mailer.sent.length).toBe(2)
  })

  test('a mail-provider failure is an event, not a different reply', async () => {
    const t = setup({ mailer: { send: async () => { throw new Error('provider down') } } })
    const res = await requestLink(t)
    expect(res.status).toBe(202)
    expect(t.events.find(e => e.type === 'send-failed').reason).toContain('provider down')
  })

  test('a form post gets an HTML page', async () => {
    const t = setup()
    const res = await t.ml.handleRequest(formReq('/auth/magic/request', { email: ALLOWED }))
    await t.ml.settled()
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Check your email')
  })

  test('the reply is padded to the response floor', async () => {
    const waits = []
    const t = setup({ sleep: async ms => { waits.push(ms) }, minResponseMs: 400 })
    await requestLink(t, 'stranger@nowhere.com')
    expect(waits[0]).toBe(400)
  })
})

describe('confirm (GET) is scanner-safe', () => {
  test('five prefetches leave the link redeemable', async () => {
    const t = setup()
    await requestLink(t)
    const link = t.mailer.lastLink()
    for (let i = 0; i < 5; i++) {
      const res = await t.ml.handleConfirm(new Request(link))
      expect(res.status).toBe(200)
    }
    const page = await (await t.ml.handleConfirm(new Request(link))).text()
    expect(page).toContain('g***@client.ie')
    const res = await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token: tokenOf(link) }))
    expect(res.status).toBe(303)
    expect(res.headers.get('set-cookie')).toContain(`session=${ALLOWED}`)
  })

  test('confirm sends no-store, no-referrer and frame denial', async () => {
    const t = setup()
    await requestLink(t)
    const res = await t.ml.handleConfirm(new Request(t.mailer.lastLink()))
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  test('an unknown token renders the expired page', async () => {
    const t = setup()
    const res = await t.ml.handleConfirm(new Request(`${ORIGIN}/auth/magic/confirm?token=nope`))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('expired')
  })
})

describe('redeem (POST)', () => {
  async function linked(t) { await requestLink(t); return tokenOf(t.mailer.lastLink()) }

  test('works exactly once', async () => {
    const t = setup()
    const token = await linked(t)
    expect((await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token }))).status).toBe(303)
    expect((await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token }))).status).toBe(400)
  })

  test('two concurrent redeems produce exactly one session', async () => {
    const t = setup()
    const token = await linked(t)
    const [a, b] = await Promise.all([
      t.ml.handleRedeem(formReq('/auth/magic/redeem', { token })),
      t.ml.handleRedeem(formReq('/auth/magic/redeem', { token })),
    ])
    expect([a.status, b.status].sort()).toEqual([303, 400])
  })

  test('expires after the TTL', async () => {
    const t = setup()
    const token = await linked(t)
    t.tick(15 * 60 * 1000 + 1)
    expect((await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token }))).status).toBe(400)
  })

  test('a newer request supersedes the older link', async () => {
    const t = setup()
    const first = await linked(t)
    const second = await linked(t)
    expect((await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token: first }))).status).toBe(400)
    expect((await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token: second }))).status).toBe(303)
  })

  test('withdrawing access kills an outstanding link', async () => {
    const t = setup()
    const token = await linked(t)
    t.allow.delete(ALLOWED)
    expect((await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token }))).status).toBe(403)
  })

  test('a cross-origin POST is refused', async () => {
    const t = setup()
    const token = await linked(t)
    const res = await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token }, { origin: 'https://evil.example' }))
    expect(res.status).toBe(403)
    // and the token survives for the real person
    expect((await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token }, { origin: ORIGIN }))).status).toBe(303)
  })

  test('onRedeemed controls the redirect and may set several cookies', async () => {
    const t = setup({ onRedeemed: async () => ({ redirectTo: '/database', setCookie: ['a=1; Path=/', 'b=2; Path=/'] }) })
    const token = await linked(t)
    const res = await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token }))
    expect(res.headers.get('location')).toBe('/database')
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/'])
  })

  test('bindToRequester: only the requesting browser can redeem', async () => {
    const t = setup({ bindToRequester: true })
    const res = await requestLink(t)
    const cookie = res.headers.get('set-cookie').split(';')[0]
    const token = tokenOf(t.mailer.lastLink())
    expect((await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token }))).status).toBe(403)
    expect((await t.ml.handleRedeem(formReq('/auth/magic/redeem', { token }, { cookie }))).status).toBe(303)
  })
})

describe('libsql store', () => {
  test('full flow on libSQL, including the single-use race', async () => {
    const store = libsqlStore(createClient({ url: ':memory:' }))
    const t = setup({ store })
    await requestLink(t)
    const token = tokenOf(t.mailer.lastLink())
    expect((await t.ml.handleConfirm(new Request(t.mailer.lastLink()))).status).toBe(200)
    const [a, b] = await Promise.all([
      t.ml.handleRedeem(formReq('/auth/magic/redeem', { token })),
      t.ml.handleRedeem(formReq('/auth/magic/redeem', { token })),
    ])
    expect([a.status, b.status].sort()).toEqual([303, 400])
  })

  test('rejects a non-identifier table prefix', () => {
    expect(() => libsqlStore(createClient({ url: ':memory:' }), { tablePrefix: 'x; DROP' })).toThrow()
  })
})

describe('hono adapter', () => {
  test('mounts the four routes', async () => {
    const t = setup({ basePath: '/api/auth/magic' })
    const app = mountMagicLink(new Hono(), t.ml)
    expect((await app.request('/api/auth/magic')).status).toBe(200)
    const r = await app.request(jsonReq('/api/auth/magic/request', { email: ALLOWED }))
    await t.ml.settled()
    expect(r.status).toBe(202)
    const link = t.mailer.lastLink()
    expect(link.startsWith(`${ORIGIN}/api/auth/magic/confirm`)).toBe(true)
    expect((await app.request(new Request(link))).status).toBe(200)
    expect((await app.request(formReq('/api/auth/magic/redeem', { token: tokenOf(link) }))).status).toBe(303)
  })
})

describe('helpers and options', () => {
  test('normaliseEmail', () => {
    expect(normaliseEmail(' A@B.co ')).toBe('a@b.co')
    for (const bad of ['', 'a', 'a@b', 'a@@b.co', 'a b@c.co', null, 'x'.repeat(250) + '@b.co']) expect(normaliseEmail(bad)).toBeNull()
  })
  test('maskEmail', () => expect(maskEmail('stephen@ibec.ie')).toBe('s***@ibec.ie'))
  test('publicOrigin is mandatory', () => {
    expect(() => createMagicLink({ appName: 'x', isAllowed: async () => true, onRedeemed: async () => ({}), store: memoryStore(), mailer: captureMailer() })).toThrow(/publicOrigin/)
  })
  test('an onEvent sink that throws does not break sign-in', async () => {
    const t = setup({ onEvent: () => { throw new Error('sink down') } })
    expect((await requestLink(t)).status).toBe(202)
    expect(t.mailer.sent.length).toBe(1)
  })
})
