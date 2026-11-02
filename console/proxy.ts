import { NextResponse, type NextRequest } from 'next/server'
import { COOKIE, valid } from '@/lib/session'

// Every console page and API proxy route requires a console session.
export function proxy(req: NextRequest) {
  if (valid(req.cookies.get(COOKIE)?.value)) return NextResponse.next()
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  }
  return NextResponse.redirect(new URL('/login', req.url))
}

export const config = {
  matcher: ['/((?!login|api/login|_next/static|_next/image|favicon.ico).*)'],
}
