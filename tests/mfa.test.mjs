// Multi-factor sign-in (TOTP) against a running stack. Codes are computed here with an independent
// RFC 6238 implementation, so the test also cross-checks the server's.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const API = process.env.KODUDB_URL ?? 'http://127.0.0.1:8787'
const RUN = Date.now().toString(36)
const PASSWORD = 'correct-horse-battery'

async function call(path, { key, token, method = 'GET', body } = {}) {
  const headers = { apikey: key }
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data = text
  try { data = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, data }
}

function base32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, buf = 0
  const out = []
  for (const c of s) {
    buf = (buf << 5) | A.indexOf(c)
    bits += 5
    if (bits >= 8) { out.push((buf >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}
/** The code for the current 30 s step plus `offset` steps. */
function totp(secret, offset = 0) {
  const step = Buffer.alloc(8)
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset))
  const h = createHmac('sha1', base32decode(secret)).update(step).digest()
  const o = h[19] & 15
  const n = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6
  return String(n).padStart(6, '0')
}
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())

let p
const P = (path) => `/p/${p.slug}${path}`
const anon = (path, opts = {}) => call(P(path), { ...opts, key: p.public_key })
const admin = (path, opts = {}) => call(P(path), { ...opts, key: p.secret_key })
const signIn = (email, password = PASSWORD) => anon('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } })

before(async () => {
  p = (await call('/platform/v1/projects', { key: env.SECRET_KEY, method: 'POST', body: { name: `Mfa ${RUN}` } })).data
})
after(async () => {
  if (p) await call(`/platform/v1/projects/${p.slug}`, { key: env.SECRET_KEY, method: 'DELETE' })
})

describe('authenticator setup', () => {
  const email = `mfa-${RUN}@example.test`
  let first, factor
  test('needs a signed-in user', async () => {
    assert.equal((await anon('/auth/v1/factors', { method: 'POST', body: {} })).status, 401)
  })
  test('enrolling returns a secret, an otpauth URI and a QR code', async () => {
    first = (await anon('/auth/v1/signup', { method: 'POST', body: { email, password: PASSWORD } })).data
    const r = await anon('/auth/v1/factors', { token: first.access_token, method: 'POST', body: { friendly_name: 'Phone' } })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    factor = r.data
    assert.match(factor.totp.secret, /^[A-Z2-7]{32}$/)
    assert.match(factor.totp.uri, /^otpauth:\/\/totp\/KoduDB%20mfa-/)
    assert.ok(factor.totp.qr_code.startsWith('data:image/svg+xml;base64,'))
    assert.match(Buffer.from(factor.totp.qr_code.split(',')[1], 'base64').toString(), /<svg/)
  })
  test('a wrong code does not verify; the right one does and gives a two-factor session', async () => {
    assert.equal((await anon(`/auth/v1/factors/${factor.id}/verify`, { token: first.access_token, method: 'POST', body: { code: '000000' } })).status, 400)
    const r = await anon(`/auth/v1/factors/${factor.id}/verify`, { token: first.access_token, method: 'POST', body: { code: totp(factor.totp.secret) } })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(claims(r.data.access_token).aal, 'aal2')
    assert.equal(r.data.user.mfa_enabled, true)
  })
  test('a second authenticator is refused while one is active', async () => {
    assert.equal((await anon('/auth/v1/factors', { token: first.access_token, method: 'POST', body: {} })).status, 409)
  })
  test('the factor is listed, without its secret', async () => {
    const r = await anon('/auth/v1/factors', { token: first.access_token })
    assert.equal(r.data.length, 1)
    assert.equal(r.data[0].status, 'verified')
    assert.ok(!JSON.stringify(r.data).includes(factor.totp.secret))
  })
})

describe('sign-in with an authenticator', () => {
  const email = `mfa-${RUN}@example.test`
  let factorSecret, challenge, aal2
  before(async () => {
    const s = (await signIn(email)).data
    challenge = s
    // Recover the secret for this test user from the earlier describe via a fresh enrol is impossible
    // (one active factor), so read it back through the factor the first suite created.
    factorSecret = (await admin('/meta/v1/query', { method: 'POST', body: { query: `select pgp_sym_decrypt(f.secret_enc, '${(env.ENCRYPTION_KEY || env.JWT_SECRET).replaceAll("'", "''")}') from auth.mfa_factors f join auth.users u on u.id = f.user_id where u.email = '${email}'` } })).data.rows[0][0]
  })
  test('a password alone returns a challenge, not a session', () => {
    assert.equal(challenge.mfa_required, true)
    assert.equal(challenge.access_token, undefined)
    assert.ok(challenge.mfa_token)
    assert.equal(challenge.factors.length, 1)
  })
  test('the challenge token cannot be used as a session', async () => {
    assert.equal((await anon('/auth/v1/user', { token: challenge.mfa_token })).status, 401)
  })
  test('a wrong code is refused; the right code gives an aal2 session', async () => {
    const bad = await anon('/auth/v1/token?grant_type=mfa_totp', { method: 'POST', body: { mfa_token: challenge.mfa_token, code: '123456' } })
    assert.equal(bad.status, 400)
    const ok = await anon('/auth/v1/token?grant_type=mfa_totp', { method: 'POST', body: { mfa_token: challenge.mfa_token, code: totp(factorSecret, 1) } })
    assert.equal(ok.status, 200, JSON.stringify(ok.data))
    assert.equal(claims(ok.data.access_token).aal, 'aal2')
    aal2 = ok.data
  })
  test('a code cannot be used twice', async () => {
    const again = await anon('/auth/v1/token?grant_type=mfa_totp', { method: 'POST', body: { mfa_token: challenge.mfa_token, code: totp(factorSecret, 1) } })
    assert.equal(again.status, 400)
  })
  test('refreshing keeps the two-factor level', async () => {
    const r = await anon('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: aal2.refresh_token } })
    assert.equal(claims(r.data.access_token).aal, 'aal2')
  })
  test('removing the authenticator needs a two-factor session', async () => {
    const list = (await anon('/auth/v1/factors', { token: aal2.access_token })).data
    const aal1 = (await anon('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: (await anon('/auth/v1/signup', { method: 'POST', body: { email: `tmp-${RUN}@example.test`, password: PASSWORD } })).data.refresh_token } })).data
    assert.equal((await anon(`/auth/v1/factors/${list[0].id}`, { token: aal1.access_token, method: 'DELETE' })).status, 404) // someone else's factor
    assert.equal((await anon(`/auth/v1/factors/${list[0].id}`, { token: aal2.access_token, method: 'DELETE' })).status, 204)
    const plain = await signIn(email)
    assert.ok(plain.data.access_token, 'password sign-in works again without a code')
    assert.equal(claims(plain.data.access_token).aal, 'aal1')
  })
})

describe('admin and limits', () => {
  test('an admin can reset a lost authenticator', async () => {
    const email = `lost-${RUN}@example.test`
    const s = (await anon('/auth/v1/signup', { method: 'POST', body: { email, password: PASSWORD } })).data
    const f = (await anon('/auth/v1/factors', { token: s.access_token, method: 'POST', body: {} })).data
    await anon(`/auth/v1/factors/${f.id}/verify`, { token: s.access_token, method: 'POST', body: { code: totp(f.totp.secret) } })
    assert.equal((await signIn(email)).data.mfa_required, true)
    const users = (await admin(`/auth/v1/admin/users?search=lost-${RUN}`)).data.users
    assert.equal(users[0].mfa_enabled, true)
    assert.equal((await anon(`/auth/v1/admin/users/${s.user.id}/factors`, { method: 'DELETE' })).status, 403)
    const r = await admin(`/auth/v1/admin/users/${s.user.id}/factors`, { method: 'DELETE' })
    assert.equal(r.data.removed, 1)
    assert.ok((await signIn(email)).data.access_token)
  })
  test('the unenrol of a working factor with a password-only session is refused', async () => {
    const email = `strict-${RUN}@example.test`
    const s = (await anon('/auth/v1/signup', { method: 'POST', body: { email, password: PASSWORD } })).data
    const f = (await anon('/auth/v1/factors', { token: s.access_token, method: 'POST', body: {} })).data
    await anon(`/auth/v1/factors/${f.id}/verify`, { token: s.access_token, method: 'POST', body: { code: totp(f.totp.secret) } })
    assert.equal((await anon(`/auth/v1/factors/${f.id}`, { token: s.access_token, method: 'DELETE' })).status, 403) // signup session is aal1
  })
  test('five wrong codes pause sign-in for that user', async () => {
    const email = `strict-${RUN}@example.test`
    const ch = (await signIn(email)).data
    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await anon('/auth/v1/token?grant_type=mfa_totp', { method: 'POST', body: { mfa_token: ch.mfa_token, code: '999999' } })).status)
    assert.deepEqual(statuses, [400, 400, 400, 400, 400, 429])
  })
})
