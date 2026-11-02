// OpenAPI document for the selected project, built from its live schema.
import { API, PUBLIC_URL, currentProject } from '@/lib/project'
import { buildSpec, type SchemaInput } from '@/lib/openapi'

export async function GET() {
  const p = await currentProject()
  const headers = { apikey: p.secret_key, authorization: `Bearer ${p.secret_key}` }
  const get = async <T,>(path: string): Promise<T> => {
    const r = await fetch(`${API}${p.path}${path}`, { headers, cache: 'no-store' })
    if (!r.ok) throw new Error(`${path}: ${r.status}`)
    return r.json() as Promise<T>
  }
  try {
    const tables = await get<{ name: string; rls_enabled: boolean }[]>('/meta/v1/tables')
    const withCols = await Promise.all(tables.map(async (t) => ({ ...t, columns: await get<SchemaInput['tables'][number]['columns']>(`/meta/v1/tables/${t.name}/columns`) })))
    const functions = await get<SchemaInput['functions']>('/meta/v1/functions')
    return Response.json(buildSpec({ server: PUBLIC_URL + p.path, project: p.name, input: { tables: withCols, functions } }))
  } catch (e) {
    return Response.json({ error: `Could not read the schema: ${(e as Error).message}` }, { status: 502 })
  }
}
