// Server-only: resolves the console's selected project to its API prefix and keys.
import { cookies } from 'next/headers'
import { sessionToken } from './session'

export const PROJECT_COOKIE = 'kodu_project'
export const API = process.env.KODUDB_API_URL ?? 'http://localhost:8787'
export const PUBLIC_URL = process.env.KODUDB_PUBLIC_URL ?? 'http://localhost:8787'

export type ProjectInfo = { slug: string; name: string; path: string; public_key: string; secret_key: string }

const TTL_MS = 5 * 60_000
const cache = new Map<string, { exp: number; info: ProjectInfo }>()

const NONE: ProjectInfo = { slug: 'default', name: 'Default project', path: '', public_key: '', secret_key: '' }

/** A project's API prefix and keys, read from the API with the console session's platform token. */
export async function projectInfo(slug: string, token: string): Promise<ProjectInfo> {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(slug)) slug = 'default'
  const hit = cache.get(slug)
  if (hit && hit.exp > Date.now()) return hit.info
  const res = await fetch(`${API}/platform/v1/projects/${slug}`, { headers: { apikey: token, authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => null)
  // A deleted or unknown project falls back to the default one instead of breaking the console.
  if (!res?.ok) return slug === 'default' ? NONE : projectInfo('default', token)
  const info = (await res.json()) as ProjectInfo
  cache.set(slug, { exp: Date.now() + TTL_MS, info })
  return info
}

export async function currentProject(): Promise<ProjectInfo> {
  return projectInfo((await cookies()).get(PROJECT_COOKIE)?.value ?? 'default', await sessionToken())
}

export function forget(slug: string) {
  cache.delete(slug)
}
