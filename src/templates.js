// Default email and page templates. Every one can be overridden through
// createMagicLink({ templates: { … } }). All interpolated values are escaped.

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function email({ appName, link, minutes }) {
  const subject = `Your sign-in link for ${appName}`
  const text = [
    `Here is your sign-in link for ${appName}:`,
    '',
    link,
    '',
    `It works once and expires in ${minutes} minutes.`,
    'If you did not ask for it, ignore this email; nobody can use it without access to your inbox.',
  ].join('\n')
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b;line-height:1.5">
<p>Here is your sign-in link for <strong>${escapeHtml(appName)}</strong>:</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none">Sign in to ${escapeHtml(appName)}</a></p>
<p style="font-size:13px;color:#52525b">Or paste this address into your browser:<br>${escapeHtml(link)}</p>
<p style="font-size:13px;color:#52525b">It works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email.</p>
</body></html>`
  return { subject, text, html }
}

function page({ appName, title, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ${escapeHtml(appName)}</title>
<style>
:root{--bg:#f4f4f5;--card:#fff;--text:#18181b;--muted:#52525b;--border:#e4e4e7;--accent:#4f46e5;--accent-text:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--card:#1a1d27;--text:#e4e4e7;--muted:#a1a1aa;--border:#2a2d37;--accent:#6366f1}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:2.5rem 2rem;max-width:400px;width:100%;text-align:center}
h1{font-size:1.4rem;margin:0 0 .75rem}p{color:var(--muted);margin:0 0 1.5rem;line-height:1.5}
input{width:100%;padding:.7rem .8rem;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:1rem;margin-bottom:.75rem}
button{width:100%;padding:.75rem 1rem;border:0;border-radius:8px;background:var(--accent);color:var(--accent-text);font-size:1rem;font-weight:600;cursor:pointer}
</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`
}

export function requestForm({ appName, actionPath }) {
  return page({
    appName, title: `Sign in to ${appName}`,
    body: `<p>Enter your email address. If it has access, we will send you a sign-in link.</p>
<form method="post" action="${escapeHtml(actionPath)}">
<input type="email" name="email" autocomplete="email" required placeholder="you@example.com" aria-label="Email address">
<button type="submit">Email me a sign-in link</button></form>`,
  })
}

export function checkEmail({ appName, message }) {
  return page({ appName, title: 'Check your email', body: `<p>${escapeHtml(message)}</p>` })
}

export function confirm({ appName, maskedEmail, token, actionPath }) {
  return page({
    appName, title: `Sign in to ${appName}`,
    body: `<p>You are signing in as <strong>${escapeHtml(maskedEmail)}</strong>.</p>
<form method="post" action="${escapeHtml(actionPath)}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Sign in</button></form>`,
  })
}

export function invalid({ appName, requestPath }) {
  return page({
    appName, title: 'This link has expired',
    body: `<p>The link has expired, has already been used, or has been replaced by a newer one.</p>
<form method="post" action="${escapeHtml(requestPath)}">
<input type="email" name="email" autocomplete="email" required placeholder="you@example.com" aria-label="Email address">
<button type="submit">Send me a new link</button></form>`,
  })
}
