// Creates or completes .env: fills in every missing value and never changes one that is set, so it is
// safe to run before each start (Docker Compose, PM2, Windows service, any host with a .env file).
//   node scripts/gen-env.mjs            create .env, or add what is missing to it
//   node scripts/gen-env.mjs --rotate   new JWT_SECRET, PUBLIC_KEY and SECRET_KEY for the default project;
//                                       keeps the database and console passwords and the encryption key
//   KODUDB_ENV_FILE=path                write somewhere other than ./.env
// Platforms without a .env file (Railpack, Nixpacks, buildpacks, Heroku) need none of this: the API
// generates missing secrets on first start and keeps them in its database.
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const target = process.env.KODUDB_ENV_FILE || fileURLToPath(new URL('../.env', import.meta.url))
const rotate = process.argv.includes('--rotate')
const token = (bytes) => randomBytes(bytes).toString('base64url')

function jwt(secret, payload) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}
function keysFor(secret) {
  const iat = Math.floor(Date.now() / 1000)
  const exp = iat + 10 * 365 * 24 * 3600
  return {
    PUBLIC_KEY: jwt(secret, { role: 'anon', iss: 'kodudb', iat, exp }),
    SECRET_KEY: jwt(secret, { role: 'service_role', iss: 'kodudb', iat, exp }),
  }
}

const existed = existsSync(target)
if (rotate && !existed) throw new Error(`${target} not found; run without --rotate first`)
const lines = existed ? readFileSync(target, 'utf8').split(/\r?\n/) : []
const env = Object.fromEntries(lines.filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
const set = {}

if (rotate) {
  // Older installs encrypted stored secrets with JWT_SECRET: pin it as ENCRYPTION_KEY so they stay readable.
  if (!env.ENCRYPTION_KEY) set.ENCRYPTION_KEY = env.JWT_SECRET
  set.JWT_SECRET = token(48)
  Object.assign(set, keysFor(set.JWT_SECRET))
} else {
  const fill = (k, v) => { if (!env[k]) set[k] = typeof v === 'function' ? v() : v }
  fill('POSTGRES_PASSWORD', () => randomBytes(24).toString('hex'))
  // An install that has JWT_SECRET but no ENCRYPTION_KEY encrypted with JWT_SECRET: keep using it.
  fill('ENCRYPTION_KEY', () => env.JWT_SECRET || token(48))
  fill('JWT_SECRET', () => token(48))
  const secret = env.JWT_SECRET || set.JWT_SECRET
  if (!env.PUBLIC_KEY || !env.SECRET_KEY || set.JWT_SECRET) Object.assign(set, keysFor(secret))
  fill('DASHBOARD_USERNAME', 'admin')
  fill('DASHBOARD_PASSWORD', () => token(15))
  fill('KODUDB_PUBLIC_URL', 'http://localhost:8787')
  // Root credentials of the bundled S3 storage (RustFS). KoduDB uses them to create one limited key per project.
  fill('S3_ACCESS_KEY', () => 'kodudb' + randomBytes(7).toString('hex'))
  fill('S3_SECRET_KEY', () => token(30))
  // For hosts that run the API directly (PM2, Windows): the database it connects to.
  fill('DATABASE_URL', () => `postgres://postgres:${env.POSTGRES_PASSWORD || set.POSTGRES_PASSWORD}@127.0.0.1:5432/kodudb`)
}

const names = Object.keys(set)
if (names.length === 0) {
  console.log(`${target} is complete; nothing to add`)
  process.exit(0)
}
// Replace changed keys in place; append new ones. Comments and other lines are kept.
const out = lines.map((l) => {
  const k = l.slice(0, l.indexOf('='))
  return /^[A-Z0-9_]+=/.test(l) && k in set ? `${k}=${set[k]}` : l
})
while (out.length && out[out.length - 1] === '') out.pop()
for (const k of names) if (!(k in env)) out.push(`${k}=${set[k]}`)
writeFileSync(target, out.join('\n') + '\n')

console.log(`${existed ? 'updated' : 'wrote'} ${target}: ${names.join(', ')}`)
if (set.DASHBOARD_PASSWORD) {
  console.log(`\n  KoduDB console sign-in\n    username: ${env.DASHBOARD_USERNAME || set.DASHBOARD_USERNAME}\n    password: ${set.DASHBOARD_PASSWORD}\n`)
}
if (rotate) console.log('restart the API and console to use the new keys')
