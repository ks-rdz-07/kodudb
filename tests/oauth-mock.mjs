// Identity provider mock for tests, on port 18997:
//  - GitHub Enterprise shape (/login/oauth/access_token, /api/v3/user, /api/v3/user/emails)
//  - an OpenID Connect provider under /oidc (discovery, token, userinfo, jwks) that signs RS256 ID tokens
// The code the test passes to the callback is the profile itself (base64url JSON), so each test
// chooses who signs in and which check should fail.
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'

const CLIENT = { id: 'test-client', secret: 'test-secret' }
const ISSUER = 'http://kodudb-oauthmock:18997/oidc'
const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 })
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
const decode = (code) => JSON.parse(Buffer.from(code, 'base64url').toString())

function idToken(claims, signer = key.privateKey) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
  const body = b64(claims)
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), signer).toString('base64url')}`
}

createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const send = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const path = new URL(req.url, 'http://x').pathname
  const form = Object.fromEntries(new URLSearchParams(body))

  // ---- GitHub ----
  if (path === '/login/oauth/access_token' && req.method === 'POST') {
    if (form.client_id !== CLIENT.id || form.client_secret !== CLIENT.secret) return send(200, { error: 'incorrect_client_credentials' })
    if (!form.code || form.code === 'bad') return send(200, { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' })
    return send(200, { access_token: `tok.${form.code}`, token_type: 'bearer', scope: 'read:user,user:email' })
  }
  if (path.startsWith('/api/v3/')) {
    let profile
    try { profile = decode((req.headers.authorization ?? '').replace(/^Bearer tok\./, '')) } catch { return send(401, { message: 'Bad credentials' }) }
    if (path === '/api/v3/user') return send(200, { id: profile.id, login: profile.login, name: null, avatar_url: `https://avatars.example/${profile.id}`, email: null })
    if (path === '/api/v3/user/emails') return send(200, profile.emails)
  }

  // ---- OpenID Connect ----
  if (path === '/oidc/.well-known/openid-configuration') {
    return send(200, {
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`, jwks_uri: `${ISSUER}/jwks`,
      token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'],
    })
  }
  if (path === '/oidc/jwks') return send(200, { keys: [{ ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] })
  if (path === '/oidc/token' && req.method === 'POST') {
    // This provider only accepts client_secret_basic, as its discovery document says.
    if (req.headers.authorization !== `Basic ${Buffer.from(`${CLIENT.id}:${CLIENT.secret}`).toString('base64')}`) return send(401, { error: 'invalid_client' })
    let p
    try { p = decode(form.code) } catch { return send(400, { error: 'invalid_grant', error_description: 'unknown code' }) }
    const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url')
    if (challenge !== p.challenge) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      iss: p.tamper === 'iss' ? 'https://elsewhere.example' : ISSUER, aud: p.tamper === 'aud' ? 'another-client' : CLIENT.id,
      sub: p.sub, email: p.email, email_verified: p.email_verified, nonce: p.tamper === 'nonce' ? 'other' : p.nonce, iat: now, exp: now + 300,
    }
    return send(200, { access_token: `at.${form.code}`, token_type: 'Bearer', expires_in: 300, id_token: idToken(claims, p.tamper === 'sig' ? rogue.privateKey : key.privateKey) })
  }
  if (path === '/oidc/userinfo') {
    try {
      const p = decode((req.headers.authorization ?? '').replace(/^Bearer at\./, ''))
      return send(200, { sub: p.sub, email: p.email, email_verified: p.email_verified, name: 'Customer', preferred_username: `user-${p.sub}`, picture: `https://avatars.example/${p.sub}` })
    } catch { return send(401, { error: 'invalid_token' }) }
  }
  send(404, { message: `mock: no route ${req.method} ${path}` })
}).listen(18997, '0.0.0.0')
