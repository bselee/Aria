import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

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

  if (!token || token !== expectedToken) {
    console.log('[SECURITY] Blocked unauthenticated dashboard API request:', request.nextUrl.pathname)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/api/dashboard/:path*',
}
