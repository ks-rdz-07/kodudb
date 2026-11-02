import { NextResponse } from 'next/server'
import { PROJECT_COOKIE, PUBLIC_URL, currentProject, forget } from '@/lib/project'

export async function GET() {
  const p = await currentProject()
  return NextResponse.json({ slug: p.slug, name: p.name, endpoint: PUBLIC_URL + p.path })
}

/** Drop cached keys for a project (after its keys were rotated). */
export async function PUT(req: Request) {
  const { slug } = (await req.json().catch(() => ({}))) as { slug?: string }
  if (slug) forget(slug)
  return NextResponse.json({ ok: true })
}

/** Select the project the console works on. */
export async function POST(req: Request) {
  const { slug } = (await req.json().catch(() => ({}))) as { slug?: string }
  if (!slug || !/^[a-z][a-z0-9-]{1,62}$/.test(slug)) return NextResponse.json({ error: 'invalid project' }, { status: 400 })
  forget(slug)
  const res = NextResponse.json({ ok: true })
  res.cookies.set(PROJECT_COOKIE, slug, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 365 * 24 * 3600 })
  return res
}
