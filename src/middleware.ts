import { NextRequest, NextResponse } from "next/server";

/**
 * Edge middleware: gate the dashboard and its API behind a shared token.
 *
 * The dashboard API can send POs to vendors, forward invoices to Bill.com, and
 * approve reconciliations. None of those routes had any auth — anyone on the
 * network could hit them. This middleware closes that hole.
 *
 * Opt-in by design: if `DASHBOARD_AUTH_TOKEN` is unset the gate is disabled and
 * behaviour is unchanged (so an existing deployment keeps working until the
 * token is configured). Once set, every `/dashboard` and `/api/dashboard/*`
 * request must present the token via:
 *   - cookie `aria_dash`            (set automatically on first valid ?token=)
 *   - header `x-aria-dash-token`    (for programmatic callers)
 *   - query  `?token=...`           (one-time, to bootstrap the cookie)
 *
 * Runs on the Edge runtime, so it cannot use Node's `crypto`; a length-checked
 * constant-time-ish compare is sufficient for a single shared secret.
 */

const COOKIE = "aria_dash";

function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export function middleware(req: NextRequest) {
    const expected = process.env.DASHBOARD_AUTH_TOKEN;

    // Gate disabled until a token is configured — preserves existing behaviour.
    if (!expected) return NextResponse.next();

    const url = req.nextUrl;
    const provided =
        req.cookies.get(COOKIE)?.value ??
        req.headers.get("x-aria-dash-token") ??
        url.searchParams.get("token") ??
        "";

    if (provided && safeEqual(provided, expected)) {
        const res = NextResponse.next();
        // Promote a valid ?token= into an httpOnly cookie so subsequent
        // same-origin fetches authenticate without leaking the token in URLs.
        if (url.searchParams.get("token")) {
            res.cookies.set(COOKIE, expected, {
                httpOnly: true,
                sameSite: "lax",
                secure: url.protocol === "https:",
                maxAge: 60 * 60 * 24 * 30,
                path: "/",
            });
        }
        return res;
    }

    if (url.pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return new NextResponse(
        "Unauthorized. Append ?token=YOUR_DASHBOARD_AUTH_TOKEN to this URL once to sign in.",
        { status: 401, headers: { "content-type": "text/plain" } },
    );
}

export const config = {
    matcher: ["/dashboard/:path*", "/api/dashboard/:path*"],
};
