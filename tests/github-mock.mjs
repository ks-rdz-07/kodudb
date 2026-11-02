// Minimal GitHub REST mock for tests: refs, contents, pulls. GET /__state returns what it received.
import { createServer } from 'node:http'

const state = { branches: ['main'], files: {}, pulls: [], auth: [] }

createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const send = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const path = new URL(req.url, 'http://x').pathname
  if (path === '/__state') return send(200, state)
  if (req.headers.authorization && !state.auth.includes(req.headers.authorization)) state.auth.push(req.headers.authorization)
  let m
  if ((m = path.match(/^\/repos\/acme\/backend\/git\/ref\/heads\/(.+)$/)) && req.method === 'GET') {
    return state.branches.includes(m[1]) ? send(200, { object: { sha: `sha-${m[1]}` } }) : send(404, { message: 'Not Found' })
  }
  if (path === '/repos/acme/backend/git/refs' && req.method === 'POST') {
    state.branches.push(JSON.parse(body).ref.replace('refs/heads/', ''))
    return send(201, {})
  }
  if ((m = path.match(/^\/repos\/acme\/backend\/contents\/(.+)$/)) && req.method === 'PUT') {
    const b = JSON.parse(body)
    const key = `${b.branch}:${decodeURIComponent(m[1])}`
    if (key in state.files) return send(422, { message: "sha wasn't supplied" })
    state.files[key] = Buffer.from(b.content, 'base64').toString()
    return send(201, { commit: { sha: `c${Object.keys(state.files).length}` } })
  }
  if (path === '/repos/acme/backend/pulls' && req.method === 'POST') {
    state.pulls.push(JSON.parse(body))
    return send(201, { number: state.pulls.length, html_url: `https://github.example/acme/backend/pull/${state.pulls.length}` })
  }
  send(404, { message: `mock: no route ${req.method} ${path}` })
}).listen(18999, '0.0.0.0')
