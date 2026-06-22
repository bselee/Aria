/**
 * @file    src/app/api/dash/callback/route.ts
 * @purpose OAuth2 callback endpoint for Dash API authorization.
 *          Dash redirects here after user authorizes in the browser.
 *          Exchanges the auth code for tokens and caches them.
 * @author  Hermia
 * @created 2026-06-22
 * @deps    src/lib/dash/client.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDashConfig, exchangeCode } from '@/lib/dash/client';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const error = searchParams.get('error');

    if (error) {
        return NextResponse.json(
            { error: `Authorization failed: ${error}` },
            { status: 400 },
        );
    }

    if (!code) {
        return NextResponse.json(
            { error: 'No authorization code provided.' },
            { status: 400 },
        );
    }

    try {
        const config = getDashConfig(
            `${request.nextUrl.protocol}//${request.nextUrl.host}/api/dash/callback`,
        );

        const tokens = await exchangeCode(config, code);

        return NextResponse.json({
            success: true,
            message: 'Dash authentication successful. Tokens cached. You can close this tab.',
            expiresAt: new Date(tokens.expiresAt).toISOString(),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return NextResponse.json(
            { error: `Token exchange failed: ${message}` },
            { status: 500 },
        );
    }
}
