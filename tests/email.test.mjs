// Email confirmation, password recovery, templates and the email log, against a running stack.
// SMTP is a local mock container on the stack network (tests/smtp-mock.mjs).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const API = process.env.KODUDB_URL ?? 'http://127.0.0.1:8787'
const RUN = Date.now().toString(36)
const MOCK = 'kodudb-smtpmock'
const SITE = 'http://app.example.test'
const PASSWORD = 'correct-horse-battery'

async function call(path, { key, token, method = 'GET', body, redirect } = {}) {
  const headers = { apikey: key }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect })
  const text = await res.text()
  let data = text
  try { data = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, data, headers: res.headers }
}
const root = (path, opts = {}) => call(path, { ...opts, key: env.SECRET_KEY })

const inbox = async () => (await fetch('http://127.0.0.1:18998/__mail')).json()
async function waitForMail(to, subjectPart, timeout = 8000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const m = (await inbox()).filter((x) => x.to.includes(to) && x.subject.includes(subjectPart))
    if (m.length) return m.at(-1)
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no email to ${to} with "${subjectPart}"`)
}
const totp = (secret) => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, buf = 0
  const key = []
  for (const c of secret) { buf = (buf << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { key.push((buf >>> (bits - 8)) & 255); bits -= 8 } }
  const step = Buffer.alloc(8)
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
  const h = createHmac('sha1', Buffer.from(key)).update(step).digest()
  const o = h[19] & 15
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0')
}
const linkIn = (mail) => (mail.text.match(/https?:\/\/\S+\/auth\/v1\/verify\?\S+/) ?? [])[0]
const viaHost = (link) => link.replace(/^https?:\/\/[^/]+/, API) // the link uses the public URL; call it locally

let p // project under test
const P = () => `/p/${p.slug}`
const anon = (path, opts = {}) => call(P() + path, { ...opts, key: p.public_key })
const admin = (path, opts = {}) => call(P() + path, { ...opts, key: p.secret_key })

before(async () => {
  spawnSync('podman', ['rm', '-f', MOCK])
  const file = fileURLToPath(new URL('./smtp-mock.mjs', import.meta.url))
  const r = spawnSync('podman', ['run', '-d', '--name', MOCK, '--network', 'kodudb_default', '-p', '127.0.0.1:18998:18998', '-v', `${file}:/mock.mjs:ro`, 'docker.io/library/node:24-alpine', 'node', '/mock.mjs'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  for (let i = 0; i < 50; i++) {
    try { await inbox(); break } catch { await new Promise((res) => setTimeout(res, 200)) }
  }
  p = (await root('/platform/v1/projects', { method: 'POST', body: { name: `Mail ${RUN}` } })).data
})
after(async () => {
  if (p) await root(`/platform/v1/projects/${p.slug}`, { method: 'DELETE' })
  spawnSync('podman', ['rm', '-f', MOCK])
})

describe('email settings', () => {
  test('sending without SMTP set up explains what is missing', async () => {
    const r = await admin('/auth/v1/admin/settings/test', { method: 'POST', body: { to: 'ops@example.test' } })
    assert.equal(r.status, 400)
    assert.match(r.data.error, /SMTP is not configured/)
  })
  test('settings save, and the SMTP password is never returned', async () => {
    const r = await admin('/auth/v1/admin/settings', {
      method: 'PUT',
      body: { require_email_confirmation: true, site_url: SITE, smtp_host: MOCK, smtp_port: 2525, smtp_security: 'none', smtp_user: 'mailer', smtp_password: 'smtp-secret', smtp_from: 'KoduDB <no-reply@example.test>' },
    })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.smtp_password_set, true)
    assert.ok(!JSON.stringify(r.data).includes('smtp-secret'))
    assert.equal((await admin('/auth/v1/admin/settings', { method: 'PUT', body: { site_url: 'javascript:alert(1)' } })).status, 400)
  })
  test('only the secret key can read or change settings', async () => {
    assert.equal((await anon('/auth/v1/admin/settings')).status, 403)
  })
  test('a test email arrives', async () => {
    const r = await admin('/auth/v1/admin/settings/test', { method: 'POST', body: { to: 'ops@example.test' } })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const m = await waitForMail('ops@example.test', 'test email')
    assert.match(m.html, /SMTP works/)
  })
  test('TLS settings to an unreachable server fail cleanly instead of crashing', async () => {
    await admin('/auth/v1/admin/settings', { method: 'PUT', body: { smtp_host: 'smtp.invalid', smtp_security: 'starttls', smtp_port: 587 } })
    const r = await admin('/auth/v1/admin/settings/test', { method: 'POST', body: { to: 'ops@example.test' } })
    assert.equal(r.status, 502)
    assert.equal((await call('/health')).status, 200)
    await admin('/auth/v1/admin/settings', { method: 'PUT', body: { smtp_host: MOCK, smtp_security: 'none', smtp_port: 2525 } })
  })
})

describe('confirm sign-up', () => {
  const email = `new-${RUN}@example.test`
  let link
  test('sign-up sends a confirmation link instead of a session', async () => {
    const r = await anon('/auth/v1/signup', { method: 'POST', body: { email, password: PASSWORD } })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.confirmation_sent, true)
    assert.equal(r.data.access_token, undefined)
    const m = await waitForMail(email, 'Confirm your email')
    link = linkIn(m)
    assert.ok(link?.includes(`/p/${p.slug}/auth/v1/verify`), m.text)
    assert.match(m.html, /Confirm email/)
  })
  test('an unconfirmed user cannot sign in', async () => {
    const r = await anon('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: PASSWORD } })
    assert.equal(r.status, 400)
    assert.match(r.data.error, /not confirmed/)
  })
  test('the link confirms and lands on the site with a session', async () => {
    const r = await fetch(viaHost(link), { redirect: 'manual' })
    assert.ok([302, 303, 307].includes(r.status), String(r.status))
    const loc = r.headers.get('location')
    assert.ok(loc.startsWith(`${SITE}#access_token=`), loc)
    assert.match(loc, /type=signup/)
    const signin = await anon('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: PASSWORD } })
    assert.equal(signin.status, 200)
    assert.ok(signin.data.user.email_confirmed_at)
  })
  test('a link works only once', async () => {
    const loc = (await fetch(viaHost(link), { redirect: 'manual' })).headers.get('location')
    assert.match(loc, /#error=/)
  })
  test('a link cannot redirect off the site', async () => {
    const other = `other-${RUN}@example.test`
    await anon('/auth/v1/signup', { method: 'POST', body: { email: other, password: PASSWORD } })
    const l = linkIn(await waitForMail(other, 'Confirm your email'))
    const loc = (await fetch(`${viaHost(l)}&redirect_to=${encodeURIComponent('https://evil.example/x')}`, { redirect: 'manual' })).headers.get('location')
    assert.equal(new URL(loc, SITE).origin, new URL(SITE).origin, loc)
  })
  test('an expired link is refused', async () => {
    const late = `late-${RUN}@example.test`
    await anon('/auth/v1/signup', { method: 'POST', body: { email: late, password: PASSWORD } })
    const l = linkIn(await waitForMail(late, 'Confirm your email'))
    await admin('/meta/v1/query', { method: 'POST', body: { query: "update auth.one_time_tokens set expires_at = now() - interval '1 minute' where used_at is null" } })
    const token = new URL(l).searchParams.get('token')
    const r = await anon('/auth/v1/verify', { method: 'POST', body: { token, type: 'confirm' } })
    assert.equal(r.status, 400)
  })
  test('resend sends a fresh confirmation link', async () => {
    const late = `late-${RUN}@example.test`
    const before = (await inbox()).filter((m) => m.to.includes(late)).length
    assert.equal((await anon('/auth/v1/resend', { method: 'POST', body: { email: late } })).status, 200)
    await new Promise((r) => setTimeout(r, 800))
    assert.equal((await inbox()).filter((m) => m.to.includes(late)).length, before + 1)
  })
})

describe('password recovery', () => {
  const email = `forgot-${RUN}@example.test`
  test('recover answers the same for unknown emails and sends nothing', async () => {
    const r = await anon('/auth/v1/recover', { method: 'POST', body: { email: `nobody-${RUN}@example.test` } })
    assert.equal(r.status, 200)
    await new Promise((res) => setTimeout(res, 800))
    assert.ok(!(await inbox()).some((m) => m.to.includes(`nobody-${RUN}@example.test`)))
  })
  test('the reset link gives a recovery session that can set a new password', async () => {
    await admin('/auth/v1/admin/users', { method: 'POST', body: { email, password: PASSWORD } })
    assert.equal((await anon('/auth/v1/recover', { method: 'POST', body: { email } })).status, 200)
    const link = linkIn(await waitForMail(email, 'Reset your'))
    const token = new URL(link).searchParams.get('token')
    const session = await anon('/auth/v1/verify', { method: 'POST', body: { token, type: 'recovery' } })
    assert.equal(session.status, 200, JSON.stringify(session.data))
    const upd = await anon('/auth/v1/user', { method: 'PUT', token: session.data.access_token, body: { password: 'a-brand-new-passphrase' } })
    assert.equal(upd.status, 200)
    assert.equal((await anon('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'a-brand-new-passphrase' } })).status, 200)
    assert.equal((await anon('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: PASSWORD } })).status, 400)
  })
  test('a reset link for a user with an authenticator still asks for the code', async () => {
    const email = `mfa-mail-${RUN}@example.test`
    await admin('/auth/v1/admin/users', { method: 'POST', body: { email, password: PASSWORD } })
    const s = (await anon('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: PASSWORD } })).data
    const f = (await anon('/auth/v1/factors', { token: s.access_token, method: 'POST', body: {} })).data
    assert.equal((await anon(`/auth/v1/factors/${f.id}/verify`, { token: s.access_token, method: 'POST', body: { code: totp(f.totp.secret) } })).status, 200)
    await anon('/auth/v1/recover', { method: 'POST', body: { email } })
    const link = linkIn(await waitForMail(email, 'Reset your'))
    const r = await anon('/auth/v1/verify', { method: 'POST', body: { token: new URL(link).searchParams.get('token'), type: 'recovery' } })
    assert.equal(r.data.mfa_required, true, JSON.stringify(r.data))
    assert.equal(r.data.access_token, undefined)
  })
  test('too many reset requests for one email are throttled', async () => {
    const statuses = []
    for (let i = 0; i < 4; i++) statuses.push((await anon('/auth/v1/recover', { method: 'POST', body: { email: `spam-${RUN}@example.test` } })).status)
    assert.deepEqual(statuses, [200, 200, 200, 429])
  })
})

describe('templates and the email log', () => {
  test('templates list both kinds and reject a body without {{link}}', async () => {
    const t = await admin('/auth/v1/admin/templates')
    assert.deepEqual(t.data.map((x) => x.kind), ['confirm', 'recovery'])
    assert.equal((await admin('/auth/v1/admin/templates/confirm', { method: 'PUT', body: { subject: 'Hi', body: '<p>no link</p>' } })).status, 400)
  })
  test('an edited template is used by the next email, with values escaped', async () => {
    const r = await admin('/auth/v1/admin/templates/confirm', { method: 'PUT', body: { subject: 'Welcome to {{project}}', body: '<p>Hello {{email}}</p><p><a href="{{link}}">Start</a></p>' } })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const email = `tmpl-${RUN}@example.test`
    await anon('/auth/v1/signup', { method: 'POST', body: { email, password: PASSWORD } })
    const m = await waitForMail(email, `Welcome to ${p.slug}`)
    assert.match(m.html, new RegExp(`Hello ${email.replace('.', '\\.')}`))
    assert.ok(linkIn(m))
  })
  test('the email log records sent and failed messages', async () => {
    const log = await admin('/auth/v1/admin/emails')
    assert.ok(log.data.some((e) => e.kind === 'confirm' && e.status === 'sent'))
    assert.ok(log.data.some((e) => e.kind === 'test' && e.status === 'failed'))
  })
})
