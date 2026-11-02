// Sign-in with external providers against a running stack. The providers are a mock (tests/oauth-mock.mjs)
// on the stack network: GitHub (as a GitHub Enterprise URL) and an OpenID Connect provider (as Okta).
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
const MOCK = 'kodudb-oauthmock'
const SITE = 'http://localhost:3000'

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
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())

let p
const P = (path) => `/p/${p.slug}${path}`
const anon = (path, opts = {}) => call(P(path), { ...opts, key: p.public_key })
const admin = (path, opts = {}) => call(P(path), { ...opts, key: p.secret_key })

/** A GitHub account as the mock returns it; the callback code carries it. */
const account = (id, email, { verified = true } = {}) => ({ id, login: `octo-${id}`, emails: [{ email, primary: true, verified }] })

/** Runs the browser side of the flow: authorize, then the provider's redirect back to the callback. */
async function signInWith(profile, { provider = 'github', cookie = true, state, code, redirectTo, post = false } = {}) {
  const q = redirectTo ? `&redirect_to=${encodeURIComponent(redirectTo)}` : ''
  const a = await fetch(API + P(`/auth/v1/authorize?provider=${provider}${q}`), { redirect: 'manual' })
  assert.equal(a.status, 303, await a.text())
  const consent = new URL(a.headers.get('location'))
  const c = typeof code === 'function' ? code(consent) : code ?? Buffer.from(JSON.stringify(profile)).toString('base64url')
  const s = state ?? consent.searchParams.get('state')
  const headers = cookie ? { cookie: a.headers.get('set-cookie').split(';')[0] } : {}
  const back = post
    ? await fetch(API + P('/auth/v1/callback'), { method: 'POST', redirect: 'manual', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: c, state: s }) })
    : await fetch(API + P(`/auth/v1/callback?code=${c}&state=${s}`), { redirect: 'manual', headers })
  const target = back.headers.get('location') ?? ''
  return { consent, setCookie: a.headers.get('set-cookie'), target, frag: Object.fromEntries(new URLSearchParams(target.split('#')[1] ?? '')) }
}

/** An OpenID Connect sign-in: the mock reads the claims, nonce and PKCE challenge from the code. */
const oidc = (sub, email, extra = {}) => ({
  provider: 'okta-staff',
  code: (consent) => Buffer.from(JSON.stringify({
    sub, email, email_verified: true, nonce: consent.searchParams.get('nonce'), challenge: consent.searchParams.get('code_challenge'), ...extra,
  })).toString('base64url'),
})

before(async () => {
  spawnSync('podman', ['rm', '-f', MOCK])
  const file = fileURLToPath(new URL('./oauth-mock.mjs', import.meta.url))
  const r = spawnSync('podman', ['run', '-d', '--name', MOCK, '--network', 'kodudb_default', '-p', '127.0.0.1:18997:18997', '-v', `${file}:/mock.mjs:ro`, 'docker.io/library/node:24-alpine', 'node', '/mock.mjs'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  for (let i = 0; i < 50 && !(await fetch('http://127.0.0.1:18997/oidc/jwks').then((x) => x.ok, () => false)); i++) await new Promise((res) => setTimeout(res, 200))
  p = (await call('/platform/v1/projects', { key: env.SECRET_KEY, method: 'POST', body: { name: `Oauth ${RUN}` } })).data
})
after(async () => {
  if (p) await call(`/platform/v1/projects/${p.slug}`, { key: env.SECRET_KEY, method: 'DELETE' })
  spawnSync('podman', ['rm', '-f', MOCK])
})

describe('provider settings', () => {
  test('sign-in is refused until the provider is enabled', async () => {
    const r = await anon('/auth/v1/authorize?provider=github')
    assert.equal(r.status, 400)
    assert.match(r.data.error, /not enabled/)
  })
  test('only the secret key can change providers', async () => {
    assert.equal((await anon('/auth/v1/admin/providers/github', { method: 'PUT', body: { enabled: true } })).status, 403)
    assert.equal((await admin('/auth/v1/admin/providers/Bad_Id', { method: 'PUT', body: { enabled: true } })).status, 400)
    assert.match((await admin('/auth/v1/admin/providers/my-idp', { method: 'PUT', body: { enabled: true } })).data.error, /unknown preset/)
    assert.equal((await admin('/auth/v1/admin/providers/github', { method: 'PUT', body: { enterprise_url: 'ftp://x' } })).status, 400)
  })
  test('saving shows the callback URL and never returns the secret', async () => {
    const r = await admin('/auth/v1/admin/providers/github', {
      method: 'PUT',
      body: { enabled: true, client_id: 'test-client', client_secret: 'test-secret', enterprise_url: `http://${MOCK}:18997` },
    })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const gh = r.data.find((x) => x.provider === 'github')
    assert.equal(gh.client_secret_set, true)
    assert.match(gh.callback_url, new RegExp(`/p/${p.slug}/auth/v1/callback$`))
    assert.ok(!JSON.stringify(r.data).includes('test-secret'))
  })
})

describe('sign-in with GitHub', () => {
  const email = `gh-${RUN}@example.test`
  let first
  test('authorize sends the browser to GitHub with the callback and a state cookie', async () => {
    const r = await signInWith(account(1001, email))
    assert.equal(r.consent.origin + r.consent.pathname, `http://${MOCK}:18997/login/oauth/authorize`)
    assert.equal(r.consent.searchParams.get('client_id'), 'test-client')
    assert.match(r.consent.searchParams.get('redirect_uri'), /\/auth\/v1\/callback$/)
    assert.equal(r.consent.searchParams.get('scope'), 'read:user user:email')
    assert.match(r.setCookie, /HttpOnly/)
    assert.match(r.setCookie, /SameSite=Lax/)
    first = r
  })
  test('the first sign-in creates a confirmed user and returns a session to the site', async () => {
    assert.ok(first.target.startsWith(`${SITE}#`), first.target)
    assert.equal(first.frag.type, 'oauth')
    const c = claims(first.frag.access_token)
    assert.equal(c.email, email)
    assert.equal(c.aal, 'aal1')
    const user = (await anon('/auth/v1/user', { token: first.frag.access_token })).data
    assert.deepEqual(user.providers, ['github'])
    assert.ok(user.email_confirmed_at)
    assert.equal(user.user_metadata.user_name, 'octo-1001')
  })
  test('signing in again reuses the same user', async () => {
    const again = await signInWith(account(1001, email))
    assert.equal(claims(again.frag.access_token).sub, claims(first.frag.access_token).sub)
    assert.equal((await admin(`/auth/v1/admin/users?search=gh-${RUN}`)).data.total, 1)
  })
  test('the user has no password to sign in with', async () => {
    const r = await anon('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'anything-at-all' } })
    assert.equal(r.status, 400)
  })
  test('redirect_to on the site is kept; anywhere else falls back to the site', async () => {
    assert.ok((await signInWith(account(1001, email), { redirectTo: `${SITE}/welcome` })).target.startsWith(`${SITE}/welcome#access_token=`))
    assert.ok((await signInWith(account(1001, email), { redirectTo: 'https://evil.example/x' })).target.startsWith(`${SITE}#access_token=`))
  })
})

describe('refused sign-ins', () => {
  const noSession = (r, message) => {
    assert.equal(r.frag.access_token, undefined)
    assert.match(r.frag.error, message)
  }
  test('a callback from another browser (no state cookie)', async () => {
    noSession(await signInWith(account(2001, `x-${RUN}@example.test`), { cookie: false }), /another browser/)
  })
  test('a forged state', async () => {
    noSession(await signInWith(account(2001, `x-${RUN}@example.test`), { state: 'forged' }), /expired or was not started here/)
  })
  test('a code GitHub rejects', async () => {
    noSession(await signInWith(null, { code: 'bad' }), /code passed is incorrect/)
  })
  test('an account without a verified email', async () => {
    noSession(await signInWith(account(2002, `unverified-${RUN}@example.test`, { verified: false })), /verified email address/)
  })
  test('a banned user', async () => {
    const r = await signInWith(account(2003, `ban-${RUN}@example.test`))
    const id = claims(r.frag.access_token).sub
    await admin(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: { ban: true } })
    noSession(await signInWith(account(2003, `ban-${RUN}@example.test`)), /banned/)
  })
})

describe('linking to existing accounts', () => {
  test('a confirmed password account is linked and keeps its password', async () => {
    const email = `both-${RUN}@example.test`
    const s = (await anon('/auth/v1/signup', { method: 'POST', body: { email, password: 'correct-horse-battery' } })).data
    const r = await signInWith(account(3001, email))
    assert.equal(claims(r.frag.access_token).sub, s.user.id)
    assert.equal((await anon('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'correct-horse-battery' } })).status, 200)
  })
  test('an unconfirmed account loses the password someone set before proving the address', async () => {
    const email = `squat-${RUN}@example.test`
    await admin('/auth/v1/admin/settings', { method: 'PUT', body: { require_email_confirmation: true } })
    try {
      const s = (await anon('/auth/v1/signup', { method: 'POST', body: { email, password: 'squatter-password' } })).data
      assert.equal(s.confirmation_sent, true)
      const r = await signInWith(account(3002, email))
      assert.equal(claims(r.frag.access_token).sub, s.user.id)
      assert.equal((await anon('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password: 'squatter-password' } })).status, 400)
    } finally {
      await admin('/auth/v1/admin/settings', { method: 'PUT', body: { require_email_confirmation: false } })
    }
  })
  test('a user with an authenticator gets the code challenge, not a session', async () => {
    const email = `gh-mfa-${RUN}@example.test`
    const s = (await signInWith(account(3003, email))).frag
    const f = (await anon('/auth/v1/factors', { token: s.access_token, method: 'POST', body: {} })).data
    await anon(`/auth/v1/factors/${f.id}/verify`, { token: s.access_token, method: 'POST', body: { code: totp(f.totp.secret) } })
    const r = await signInWith(account(3003, email))
    assert.equal(r.frag.access_token, undefined)
    assert.equal(r.frag.mfa_required, 'true')
    assert.ok(r.frag.mfa_token)
  })
})

describe('OpenID Connect (Okta preset)', () => {
  test('presets cover social, workforce and open-source providers', async () => {
    const ids = (await admin('/auth/v1/admin/providers/presets')).data.map((p) => p.id)
    for (const id of ['google', 'apple', 'microsoft', 'github', 'gitlab', 'discord', 'okta', 'auth0', 'clerk', 'keycloak', 'authentik', 'zitadel', 'oidc']) assert.ok(ids.includes(id), id)
    assert.equal((await anon('/auth/v1/admin/providers/presets')).status, 403)
  })
  test('an OpenID Connect provider is added under its own id', async () => {
    const r = await admin('/auth/v1/admin/providers/okta-staff', {
      method: 'PUT',
      body: { preset: 'okta', display_name: 'Staff SSO', enabled: true, client_id: 'test-client', client_secret: 'test-secret', issuer: `http://${MOCK}:18997/oidc` },
    })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const okta = r.data.find((x) => x.provider === 'okta-staff')
    assert.equal(okta.ready, true)
    assert.equal(okta.protocol, 'oidc')
    const pub = (await anon('/auth/v1/providers')).data
    assert.deepEqual(pub.map((x) => x.name).sort(), ['GitHub', 'Staff SSO'])
    assert.ok(!JSON.stringify(pub).includes('test-client'))
  })
  test('authorize uses discovery, PKCE (S256) and a nonce', async () => {
    const a = await fetch(API + P('/auth/v1/authorize?provider=okta-staff'), { redirect: 'manual' })
    const u = new URL(a.headers.get('location'))
    assert.equal(u.origin + u.pathname, `http://${MOCK}:18997/oidc/authorize`)
    assert.equal(u.searchParams.get('response_type'), 'code')
    assert.equal(u.searchParams.get('scope'), 'openid email profile')
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
    assert.match(u.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/)
    assert.ok(u.searchParams.get('nonce'))
    assert.match(a.headers.get('set-cookie'), /^kodudb-oauth-[^=]+=[0-9a-f]{32}\.[0-9a-f]{64};/)
  })
  test('a verified ID token signs in, and again as the same user', async () => {
    const email = `sso-${RUN}@example.test`
    const r = await signInWith(null, oidc('okta-1', email))
    assert.ok(r.frag.access_token, r.target)
    const user = (await anon('/auth/v1/user', { token: r.frag.access_token })).data
    assert.deepEqual(user.providers, ['okta-staff'])
    assert.equal(user.user_metadata.user_name, 'user-okta-1')
    const again = await signInWith(null, oidc('okta-1', email))
    assert.equal(claims(again.frag.access_token).sub, user.id)
  })
  test('the callback also accepts a form POST (response_mode=form_post, used by Apple)', async () => {
    const r = await signInWith(null, { ...oidc('okta-2', `post-${RUN}@example.test`), post: true })
    assert.ok(r.frag.access_token, r.target)
  })
  for (const [tamper, message] of [['sig', /ID token rejected/], ['aud', /ID token rejected/], ['iss', /ID token rejected/], ['nonce', /nonce does not match/]]) {
    test(`an ID token with a bad ${tamper} is refused`, async () => {
      const r = await signInWith(null, oidc(`okta-${tamper}`, `${tamper}-${RUN}@example.test`, { tamper }))
      assert.equal(r.frag.access_token, undefined)
      assert.match(r.frag.error, message)
    })
  }
  test('a wrong PKCE verifier is refused by the provider', async () => {
    const r = await signInWith(null, oidc('okta-3', `pkce-${RUN}@example.test`, { challenge: 'not-the-challenge' }))
    assert.equal(r.frag.access_token, undefined)
    assert.match(r.frag.error, /PKCE verification failed/)
  })
  test('an unverified email is refused unless the provider is trusted for emails', async () => {
    const who = oidc('okta-4', `trust-${RUN}@example.test`, { email_verified: false })
    assert.match((await signInWith(null, who)).frag.error, /has not verified/)
    await admin('/auth/v1/admin/providers/okta-staff', { method: 'PUT', body: { trust_email: true } })
    assert.ok((await signInWith(null, who)).frag.access_token)
    await admin('/auth/v1/admin/providers/okta-staff', { method: 'PUT', body: { trust_email: false } })
  })
  test('a removed provider no longer signs anyone in', async () => {
    assert.equal((await admin('/auth/v1/admin/providers/okta-staff', { method: 'DELETE' })).status, 204)
    assert.equal((await anon('/auth/v1/authorize?provider=okta-staff')).status, 400)
    assert.deepEqual((await anon('/auth/v1/providers')).data.map((x) => x.provider), ['github'])
  })
})

function totp(secret) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, buf = 0
  const key = []
  for (const c of secret) {
    buf = (buf << 5) | A.indexOf(c)
    bits += 5
    if (bits >= 8) { key.push((buf >>> (bits - 8)) & 255); bits -= 8 }
  }
  const step = Buffer.alloc(8)
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
  const h = createHmac('sha1', Buffer.from(key)).update(step).digest()
  const o = h[19] & 15
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0')
}
