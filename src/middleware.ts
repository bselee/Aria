import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/api/health' || request.nextUrl.pathname.startsWith('/_next')) {
    return NextResponse.next()
  }

  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  const expectedToken = process.env.DASHBOARD_API_TOKEN

  if (!expectedToken) {
    console.error('[SECURITY] DASHBOARD_API_TOKEN not configured — blocking request')
    return NextResponse.json({ error: 'Auth not configured' }, { status: 503 })
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
