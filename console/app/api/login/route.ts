import { NextResponse } from 'next/server'
import { API } from '@/lib/project'
import { COOKIE } from '@/lib/session'

// Failed console sign-ins per client per minute (the API also limits per console server).
// shortcut: in-memory and per process; behind a proxy without X-Forwarded-For all clients share one bucket.
const MAX_FAILURES = 5
const WINDOW_MS = 60_000
const failures = new Map<string, number[]>()

function clientKey(req: Request) {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local'
}

function recent(key: string, now: number) {
  const list = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  if (list.length) failures.set(key, list)
  else failures.delete(key)
  return list
}

export async function POST(req: Request) {
  const key = clientKey(req)
  const now = Date.now()
  const list = recent(key, now)
  if (list.length >= MAX_FAILURES) {
    const retry = Math.ceil((WINDOW_MS - (now - list[0])) / 1000)
    return NextResponse.json({ error: `too many attempts; try again in ${retry} s` }, { status: 429, headers: { 'retry-after': String(retry) } })
  }
  const { username, password } = (await req.json().catch(() => ({}))) as { username?: string; password?: string }
  const upstream = await fetch(`${API}/platform/v1/console/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    cache: 'no-store',
  }).catch(() => null)
  if (!upstream) return NextResponse.json({ error: 'the API is unreachable' }, { status: 502 })
  if (upstream.status === 429) return NextResponse.json(await upstream.json(), { status: 429, headers: { 'retry-after': upstream.headers.get('retry-after') ?? '60' } })
  if (!upstream.ok) {
    failures.set(key, [...list, now])
    return NextResponse.json({ error: 'wrong username or password' }, { status: 401 })
  }
  failures.delete(key)
  const { token, expires_in } = (await upstream.json()) as { token: string; expires_in: number }
  const res = NextResponse.json({ ok: true })
  // Secure when the console is served over HTTPS (directly or behind a TLS proxy).
  const https = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https'
  res.cookies.set(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: https, path: '/', maxAge: expires_in })
  return res
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(COOKIE)
  return res
}
