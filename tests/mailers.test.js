import { describe, test, expect } from 'bun:test'
import { cloudflareMailer, resendMailer } from '../src/mailers.js'

function fakeFetch(status, body) {
  const calls = []
  const f = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }) }
  return { f, calls }
}
const MSG = { to: 'guest@client.ie', subject: 'S', text: 'T', html: '<p>T</p>' }

describe('cloudflareMailer', () => {
  test('posts the REST shape: from as {address,name}, reply_to snake_case, bearer token', async () => {
    const { f, calls } = fakeFetch(200, { success: true, errors: [], result: { delivered: ['guest@client.ie'], permanent_bounces: [], queued: [] } })
    const m = cloudflareMailer({ accountId: 'acc', apiToken: 'tok', from: 'sni@brightbeam.works', fromName: 'SNI Research', replyTo: 'r@x.io', fetch: f })
    const r = await m.send(MSG)
    expect(r.delivered).toEqual(['guest@client.ie'])
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/email/sending/send')
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok')
    const body = JSON.parse(calls[0].init.body)
    expect(body.from).toEqual({ address: 'sni@brightbeam.works', name: 'SNI Research' })
    expect(body.reply_to).toBe('r@x.io')
    expect(body.to).toBe('guest@client.ie')
  })
  test('an API error throws with the Cloudflare code', async () => {
    const { f } = fakeFetch(403, { success: false, errors: [{ code: 10105, message: 'email.sending.error.authentication.not_entitled' }] })
    const m = cloudflareMailer({ accountId: 'a', apiToken: 't', from: 'x@y.io', fetch: f })
    await expect(m.send(MSG)).rejects.toThrow(/10105/)
  })
  test('a permanent bounce throws', async () => {
    const { f } = fakeFetch(200, { success: true, result: { delivered: [], permanent_bounces: ['guest@client.ie'], queued: [] } })
    const m = cloudflareMailer({ accountId: 'a', apiToken: 't', from: 'x@y.io', fetch: f })
    await expect(m.send(MSG)).rejects.toThrow(/permanent bounce/)
  })
  test('queued counts as accepted', async () => {
    const { f } = fakeFetch(200, { success: true, result: { delivered: [], permanent_bounces: [], queued: ['guest@client.ie'] } })
    const m = cloudflareMailer({ accountId: 'a', apiToken: 't', from: 'x@y.io', fetch: f })
    expect((await m.send(MSG)).queued).toEqual(['guest@client.ie'])
  })
  test('required options', () => {
    expect(() => cloudflareMailer({ apiToken: 't', from: 'x@y.io' })).toThrow(/accountId/)
    expect(() => cloudflareMailer({ accountId: 'a', from: 'x@y.io' })).toThrow(/apiToken/)
    expect(() => cloudflareMailer({ accountId: 'a', apiToken: 't' })).toThrow(/from/)
  })
})

describe('resendMailer', () => {
  test('an API error throws', async () => {
    const { f } = fakeFetch(422, { name: 'validation_error', message: 'bad from' })
    await expect(resendMailer({ apiKey: 'k', from: 'x@y.io', fetch: f }).send(MSG)).rejects.toThrow(/bad from/)
  })
})
