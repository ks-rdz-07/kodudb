// Browser-side helpers; everything goes through the authenticated /api/kodu proxy.
export async function kodu<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/kodu/${path}`, init)
  if (res.status === 401 && typeof window !== 'undefined') window.location.href = '/login'
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  return body as T
}

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export type SqlResult = { columns: string[]; rows: (string | null)[][]; row_count: number; ms: number }

export const sql = (query: string) => kodu<SqlResult>('meta/v1/query', json('POST', { query }))

export { qi, ql } from './quote.mjs'

export type Column = { name: string; type: string; nullable: boolean; default: string | null; primary_key: boolean }
export type TableInfo = { name: string; rls_enabled: boolean; rows_estimate: number; bytes: number; realtime: boolean; comment: string | null }

export const fmtBytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`
}
