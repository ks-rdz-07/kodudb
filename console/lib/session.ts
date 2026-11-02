import { cookies } from 'next/headers'

export const COOKIE = 'kodu_session'

// The session cookie holds the 12-hour platform token the API issues at console sign-in
// (POST /platform/v1/console/session). The API checks its signature on every call, so the console
// keeps no secrets; here the claims are only read (expiry to send signed-out visitors to /login,
// sub for the name in the top bar), never trusted.
function claims(token: string): { exp?: number; sub?: string } {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return {}
  }
}

export function valid(token: string | undefined): boolean {
  return !!token && (Number(claims(token).exp) || 0) > Date.now() / 1000
}

export async function username(): Promise<string> {
  return claims(await sessionToken()).sub || 'admin'
}

export async function sessionToken(): Promise<string> {
  return (await cookies()).get(COOKIE)?.value ?? ''
}
