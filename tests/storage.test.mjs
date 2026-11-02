// End-to-end tests for S3 file storage (RustFS in Compose): per-project buckets, per-project access keys
// limited to their own bucket, key rotation and cleanup. Skipped when the API stores files locally.
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
)
const API = process.env.KODUDB_URL ?? 'http://127.0.0.1:8787'
const ROOT = env.SECRET_KEY
const RUN = Date.now().toString(36)

async function call(path, { key = ROOT, method = 'GET', body, headers = {} } = {}) {
  const h = { apikey: key, ...headers }
  if (body !== undefined && typeof body !== 'string') h['content-type'] = 'application/json'
  const res = await fetch(API + path, { method, headers: h, body: body === undefined || typeof body === 'string' ? body : JSON.stringify(body) })
  const text = await res.text()
  let data = text
  try { data = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, data }
}

// Minimal AWS SigV4 for S3 GET requests (path-style), enough to list a bucket or read an object.
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const hmac = (k, s) => createHmac('sha256', k).update(s).digest()
async function s3Get(creds, path, query = '') {
  const url = new URL(creds.endpoint + path + (query ? `?${query}` : ''))
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const canonicalQuery = [...url.searchParams].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  const headers = { host: url.host, 'x-amz-content-sha256': sha256(''), 'x-amz-date': amzDate }
  const signed = Object.keys(headers).sort().join(';')
  const canonical = ['GET', url.pathname, canonicalQuery, ...Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join('').split('\n').slice(0, -1), '', signed, headers['x-amz-content-sha256']].join('\n')
  const scope = `${day}/${creds.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const key = ['s3', 'aws4_request'].reduce((k, s) => hmac(k, s), hmac(hmac(`AWS4${creds.secret_key}`, day), creds.region))
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  const res = await fetch(url, {
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${creds.access_key}/${scope}, SignedHeaders=${signed}, Signature=${signature}` },
  })
  return { status: res.status, text: await res.text() }
}

const storage = (slug) => call(`/platform/v1/projects/${slug}/storage`)

describe('S3 file storage', async () => {
  const first = await storage('default')
  if (first.data?.backend !== 's3') {
    test('skipped: the API stores files locally', { skip: true }, () => {})
    return
  }
  const other = `s3test-${RUN}`
  let otherCreds

  before(async () => {
    const p = await call('/platform/v1/projects', { method: 'POST', body: { name: other } })
    assert.equal(p.status, 200, JSON.stringify(p.data))
    otherCreds = (await storage(other)).data
  })
  after(async () => {
    await call(`/platform/v1/projects/${other}`, { method: 'DELETE' })
  })

  test('every project gets its own bucket and key', async () => {
    const d = first.data
    assert.equal(d.bucket, 'kdb-default')
    assert.match(d.access_key, /^[A-Z0-9]{20}$/)
    assert.ok(d.secret_key.length >= 30)
    assert.equal(otherCreds.bucket, `kdb-${other}`)
    assert.notEqual(otherCreds.access_key, d.access_key)
    assert.deepEqual((await storage('default')).data, d, 'stable across requests')
  })

  test('files uploaded through KoduDB land in the project bucket', async () => {
    const bucket = `s3b-${RUN}`
    assert.equal((await call('/storage/v1/bucket', { method: 'POST', body: { id: bucket } })).status, 200)
    const up = await call(`/storage/v1/object/${bucket}/notes/hello.txt`, { method: 'POST', body: 'hello s3', headers: { 'content-type': 'text/plain' } })
    assert.equal(up.status, 200, JSON.stringify(up.data))
    const down = await fetch(`${API}/storage/v1/object/${bucket}/notes/hello.txt`, { headers: { apikey: ROOT } })
    assert.equal(await down.text(), 'hello s3')
    const listed = await s3Get(first.data, `/${first.data.bucket}`, `list-type=2&prefix=${bucket}/`)
    assert.equal(listed.status, 200, listed.text)
    assert.ok(listed.text.includes(`<Key>${bucket}/notes/hello.txt</Key>`), listed.text)
    assert.ok(!listed.text.includes('_tmp/'), 'no staging leftovers')
    const object = await s3Get(first.data, `/${first.data.bucket}/${bucket}/notes/hello.txt`)
    assert.equal(object.text, 'hello s3')
    assert.equal((await call(`/storage/v1/bucket/${bucket}`, { method: 'DELETE' })).status, 204)
    const gone = await s3Get(first.data, `/${first.data.bucket}`, `list-type=2&prefix=${bucket}/`)
    assert.ok(!gone.text.includes('<Key>'), 'deleting a bucket deletes its files')
  })

  test("a project's key cannot reach another project's bucket", async () => {
    assert.equal((await s3Get(otherCreds, `/${otherCreds.bucket}`, 'list-type=2')).status, 200)
    assert.equal((await s3Get(otherCreds, `/${first.data.bucket}`, 'list-type=2')).status, 403)
    assert.equal((await s3Get(first.data, `/${otherCreds.bucket}`, 'list-type=2')).status, 403)
    assert.equal((await s3Get(otherCreds, '/')).text.includes(first.data.bucket), false, 'other buckets are not listed')
  })

  test('rotating the key retires the old one', async () => {
    const r = await call(`/platform/v1/projects/${other}/storage/rotate`, { method: 'POST' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.notEqual(r.data.access_key, otherCreds.access_key)
    assert.equal((await s3Get(r.data, `/${r.data.bucket}`, 'list-type=2')).status, 200)
    assert.equal((await s3Get(otherCreds, `/${otherCreds.bucket}`, 'list-type=2')).status, 403)
    otherCreds = r.data
  })

  test('a project can switch to its own S3 provider and back', async () => {
    const slug = `s3prov-${RUN}`
    assert.equal((await call('/platform/v1/projects', { method: 'POST', body: { name: slug } })).status, 200)
    const base = `/platform/v1/projects/${slug}/storage/provider`
    const rustfs = (await storage(slug)).data
    assert.equal(rustfs.provider, 'rustfs')
    // The bundled RustFS reached with its root keys stands in for any other S3 service (address as the API sees it).
    const good = { provider: 'minio', endpoint: process.env.KODUDB_S3_INTERNAL ?? 'http://storage:9000', region: 'us-east-1', bucket: rustfs.bucket, access_key: env.S3_ACCESS_KEY, secret_key: env.S3_SECRET_KEY }
    const put = (body) => call(base, { method: 'PUT', body })
    assert.equal((await put({ ...good, secret_key: 'wrong-secret' })).status, 400, 'a failing connection is not saved')
    assert.equal((await storage(slug)).data.provider, 'rustfs')
    assert.equal((await put({ ...good, endpoint: 'ftp://x' })).status, 400)
    assert.equal((await call(base, { method: 'PUT', body: good, key: env.PUBLIC_KEY })).status, 403)
    assert.equal((await call('/platform/v1/projects/default/storage/provider', { method: 'PUT', body: good })).status, 400, 'default project stays on RustFS')

    const saved = await put(good)
    assert.equal(saved.status, 200, JSON.stringify(saved.data))
    assert.equal(saved.data.provider, 'minio')
    assert.equal(saved.data.secret_key, null, 'the secret is never returned')
    assert.equal(saved.data.secret_set, true)
    const P = `${API}/p/${slug}`
    const h = { apikey: (await call(`/platform/v1/projects/${slug}`)).data.secret_key }
    assert.equal((await fetch(`${P}/storage/v1/bucket`, { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'docs' }) })).status, 200)
    assert.equal((await fetch(`${P}/storage/v1/object/docs/a.txt`, { method: 'POST', headers: { ...h, 'content-type': 'text/plain' }, body: 'custom' })).status, 200)
    assert.equal(await (await fetch(`${P}/storage/v1/object/docs/a.txt`, { headers: h })).text(), 'custom')
    // An empty secret keeps the stored one.
    assert.equal((await put({ ...good, secret_key: '' })).status, 200)
    assert.equal((await put({ provider: 'rustfs' })).data.provider, 'rustfs')
    assert.equal((await call(`/platform/v1/projects/${slug}`, { method: 'DELETE' })).status, 204)
  })

  test('storage details need the root key', async () => {
    assert.equal((await call('/platform/v1/projects/default/storage', { key: env.PUBLIC_KEY })).status, 403)
  })

  test('deleting a project removes its key and bucket', async () => {
    const slug = `s3gone-${RUN}`
    assert.equal((await call('/platform/v1/projects', { method: 'POST', body: { name: slug } })).status, 200)
    const creds = (await storage(slug)).data
    assert.equal((await call(`/platform/v1/projects/${slug}`, { method: 'DELETE' })).status, 204)
    const after = await s3Get(first.data, `/${creds.bucket}`, 'list-type=2')
    assert.notEqual(after.status, 200)
    assert.equal((await s3Get(creds, `/${creds.bucket}`, 'list-type=2')).status, 403)
  })
})
