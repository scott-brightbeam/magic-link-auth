# @brightbeam/magic-link

Email magic-link sign-in for **allowlisted** users. A person enters their address, and if it is on your list, a single-use link arrives that signs them in.

It handles the link lifecycle and nothing else. **Your app keeps its own session, allowlist and roles.**

- **Safe against mail scanners.** Outlook Safe Links and mail gateways open every link in an email before the person does. The link opens a page with a *Sign in* button, so a scanner's GET changes nothing. Only the button's POST redeems the link.
- **Leaks nothing.** Every address gets the same reply, padded to a constant floor, whether or not it is allowed. Only `sha256(token)` is stored.
- **Single-use.** A link works once, expires in 15 minutes and is replaced by any newer request. One conditional UPDATE means two racing clicks cannot both succeed.
- **Re-checked at redeem.** If someone is removed from the allowlist, their outstanding links die with it.
- **Rate-limited.** By default, 3 requests per address per 15 minutes and 20 per IP per hour. Requests over the limit get the same reply.
- **Framework-agnostic.** Handlers take a Fetch `Request` and return a `Response`, so they work with Hono (adapter included), Bun.serve, Workers, Next route handlers and Express via `@whatwg-node/server`.

## Install

```bash
bun add github:scott-brightbeam/magic-link-auth#v0.2.0
```

## Use (Hono + libSQL/Turso + Resend)

```js
import { createMagicLink, libsqlStore, resendMailer, consoleMailer } from '@brightbeam/magic-link'
import { mountMagicLink } from '@brightbeam/magic-link/hono'

const ml = createMagicLink({
  appName: 'My App',
  publicOrigin: 'https://my-app.example.com',        // REQUIRED: links are never built from the Host header
  basePath: '/api/auth/magic',                       // default '/auth/magic'
  isAllowed: async (email) => ALLOWLIST.includes(email), // email arrives trimmed + lowercased
  store: libsqlStore(db),                            // creates magic_link_tokens + magic_link_hits on first use
  mailer: process.env.RESEND_API_KEY
    ? resendMailer({ apiKey: process.env.RESEND_API_KEY, from: 'My App <sign-in@my-app.example.com>' })
    : consoleMailer(),                               // dev: prints the link
  // Issue YOUR session. Return cookies and, optionally, where to land.
  onRedeemed: async ({ email, request }) => ({
    setCookie: await mySessionCookie(email),         // string or string[]
    redirectTo: '/',                                 // default '/'
  }),
  onEvent: (e) => log(e),  // requested | sent | send-failed | suppressed | confirm-viewed | redeemed | rejected | error
})

mountMagicLink(app, ml)   // GET {base}, POST {base}/request, GET {base}/confirm, POST {base}/redeem
```

**If your app has an auth middleware, add `basePath` and every path under it to its public list.** These routes are how people sign in.

Your sign-in UI POSTs `{ "email": "…" }` (JSON) to `{base}/request` and shows the `message` from the reply. Alternatively, link to `GET {base}` for a ready-made form.

## Options

| Option | Default | |
|---|---|---|
| `ttlSeconds` | `900` | How long a link stays valid |
| `rateLimits` | `{ perEmail: { max: 3, windowMs: 900000 }, perIp: { max: 20, windowMs: 3600000 } }` | |
| `minResponseMs` | `400` | Reply floor for `/request` (prevents a timing oracle) |
| `bindToRequester` | `false` | `true` means the link only works in the browser that asked for it (stricter, but it breaks the "asked on a laptop, opened on a phone" case) |
| `successRedirect` | `'/'` | Used when `onRedeemed` returns no `redirectTo` |
| `getClientIp` | `fly-client-ip` → `cf-connecting-ip` → `x-forwarded-for` | For rate limiting |
| `waitUntil` | — | Workers: pass `ctx.waitUntil` so the email send outlives the reply |
| `templates` | built-in | Override `email`, `requestForm`, `checkEmail`, `confirm`, `invalid` |

## Stores and mailers

- `libsqlStore(client, { tablePrefix })` works with libSQL, Turso or SQLite (anything with `execute({ sql, args })`). `memoryStore()` is for tests and single-process development only.
- `cloudflareMailer({ accountId, apiToken, from, fromName, replyTo })` uses the Cloudflare Email Service REST API. `from` must be on a domain onboarded for Email Sending, and arbitrary recipients need the Workers Paid plan.
- `resendMailer({ apiKey, from, replyTo })`, `consoleMailer()` and `captureMailer()` (tests). A mailer is any object with `async send({ to, subject, text, html })` that throws on failure.

## Sending domain

Every provider sends only from a domain you have verified, so a `*.fly.dev` or other platform hostname cannot be the `from` address. At Brightbeam, apps live at a subdomain of `brightbeam.works` (Cloudflare DNS, with a Fly certificate for apps on Fly), and `brightbeam.works` is already onboarded for Cloudflare Email Sending, so `cloudflareMailer` with a `@brightbeam.works` sender is the default choice.

## Test

```bash
bun test
```
