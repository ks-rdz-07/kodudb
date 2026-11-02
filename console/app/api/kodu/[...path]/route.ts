// Server-side proxy to the KoduDB API with the selected project's secret key, which never reaches the browser.
import { API, currentProject } from '@/lib/project'
import { sessionToken } from '@/lib/session'

const PASS_HEADERS = ['content-type', 'prefer', 'x-upsert']

async function forward(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  // Platform calls (projects, branches, GitHub) use the console session's platform token; everything
  // else targets the selected project with its secret key.
  const platform = path[0] === 'platform'
  const project = await currentProject()
  const key = platform ? await sessionToken() : project.secret_key
  if (!key) return Response.json({ error: 'not signed in' }, { status: 401 })
  const url = new URL(req.url)
  const headers = new Headers({ apikey: key, authorization: `Bearer ${key}` })
  for (const h of PASS_HEADERS) {
    const v = req.headers.get(h)
    if (v) headers.set(h, v)
  }
  const hasBody = !['GET', 'HEAD'].includes(req.method)
  const prefix = platform ? '' : project.path
  const upstream = await fetch(`${API}${prefix}/${path.map(encodeURIComponent).join('/')}${url.search}`, {
    method: req.method,
    headers,
    body: hasBody ? await req.arrayBuffer() : undefined,
  }).catch((e: Error) => Response.json({ error: `API unreachable: ${e.message}` }, { status: 502 }))
  const out = new Headers()
  for (const h of ['content-type', 'x-total-count']) {
    const v = upstream.headers.get(h)
    if (v) out.set(h, v)
  }
  return new Response(upstream.body, { status: upstream.status, headers: out })
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE }
