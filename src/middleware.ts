import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

/**
 * Checks whether a request originates from the dashboard's own browser UI
 * by comparing the Origin / Referer headers against the request host.
 * This allows local browser sessions without requiring every fetch() call
 * to carry an Authorization header, while external API callers (Hermes,
 * cron jobs, third-party integrations) still need the Bearer token.
 */
function isSameOriginBrowserRequest(request: NextRequest): boolean {
  const host = request.headers.get('host')
  if (!host) return false

  const origin = request.headers.get('origin')
  if (origin) {
    try {
      const originHost = new URL(origin).host
      return originHost === host
    } catch {
      /* malformed origin — fall through to referer check */
    }
  }

  const referer = request.headers.get('referer')
  if (referer) {
    try {
      const refererHost = new URL(referer).host
      return refererHost === host
    } catch {
      return false
    }
  }

  return false
}

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/api/health' || request.nextUrl.pathname.startsWith('/_next')) {
    return NextResponse.next()
  }

  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  const expectedToken = process.env.DASHBOARD_API_TOKEN || process.env.HERMES_DASHBOARD_SESSION_TOKEN

  // No token configured → open gate locally (dashboard only exposed on localhost).
  // In production, set DASHBOARD_API_TOKEN to enforce auth.
  if (!expectedToken) {
    return NextResponse.next()
  }

  // Valid Bearer token always passes (external callers like Hermes/cron).
  if (token && token === expectedToken) {
    return NextResponse.next()
  }

  // Same-origin browser requests from the dashboard UI pass through.
  if (isSameOriginBrowserRequest(request)) {
    return NextResponse.next()
  }

  console.log('[SECURITY] Blocked unauthenticated dashboard API request:', request.nextUrl.pathname)
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export const config = {
  matcher: '/api/dashboard/:path*',
}
