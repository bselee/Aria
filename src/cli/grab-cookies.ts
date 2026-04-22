/**
 * grab-cookies.ts — Autonomously extract cookies from a running Chrome via CDP.
 *
 * Connects to Chrome DevTools Protocol on port 9222, grabs all cookies for
 * a target domain, and saves them as a Playwright-compatible JSON session file.
 *
 * PREREQUISITE: Chrome must be running with --remote-debugging-port=9222
 *   (see: scripts/setup-chrome-cdp.ps1 for one-time shortcut setup)
 *
 * Usage:
 *   node --import tsx src/cli/grab-cookies.ts uline.com          → .uline-session.json
 *   node --import tsx src/cli/grab-cookies.ts basauto.vercel.app  → .basauto-session.json
 *   node --import tsx src/cli/grab-cookies.ts example.com --all   → all cookies, not just domain
 *   node --import tsx src/cli/grab-cookies.ts uline.com --out custom.json
 */
import http from "http";
import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const CDP_PORT = 9222;

interface RawCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    size: number;
    httpOnly: boolean;
    secure: boolean;
    session: boolean;
    sameSite: string;
    priority: string;
    sameParty: boolean;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const domain = args.find(a => !a.startsWith("--")) || "";
    const all = args.includes("--all");
    const outIdx = args.indexOf("--out");
    const outFile = outIdx !== -1 && outIdx + 1 < args.length ? args[outIdx + 1] : null;
    return { domain, all, outFile };
}

function defaultOutputFile(domain: string): string {
    // uline.com → .uline-session.json
    // basauto.vercel.app → .basauto-session.json
    const base = domain.split(".")[0].replace(/[^a-z0-9]/gi, "");
    return path.resolve(process.cwd(), `.${base}-session.json`);
}

async function getCDPEndpoint(): Promise<string | null> {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, { timeout: 3000 }, (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => {
                try {
                    const info = JSON.parse(data);
                    resolve(info.webSocketDebuggerUrl || null);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
    });
}

async function getAllCookiesViaCDP(wsUrl: string, domain?: string): Promise<RawCookie[]> {
    const browser = await chromium.connectOverCDP(wsUrl);
    const contexts = browser.contexts();
    const ctx = contexts[0];
    if (!ctx) {
        await browser.close();
        throw new Error("No browser context found");
    }

    const page = ctx.pages()[0] || await ctx.newPage();

    // Navigate to the target domain to ensure its cookies are loaded into memory.
    // Chrome's cookie store is lazy — cookies for unvisited domains may not be in
    // the CDP cookie jar until the domain is actually accessed.
    if (domain) {
        const url = `https://www.${domain.replace(/^www\./, "")}`;
        console.log(`Visiting ${url} to load cookies...`);
        try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
        } catch {
            console.warn(`Warning: could not load ${url}, cookies may be incomplete`);
        }
    }

    // Use raw CDP Network.getAllCookies to get the ENTIRE cookie jar
    const cdpSession = await page.context().newCDPSession(page);
    const result = await cdpSession.send("Network.getAllCookies") as { cookies: RawCookie[] };
    const allCookies = result.cookies;

    // Detach CDP session, disconnect from browser (don't close it — it's the user's!)
    await cdpSession.detach();
    await browser.close();

    return allCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        size: c.size || (c.name.length + c.value.length),
        httpOnly: c.httpOnly,
        secure: c.secure,
        session: c.expires === -1 || c.expires === 0,
        sameSite: c.sameSite,
        priority: c.priority || "Medium",
        sameParty: c.sameParty || false,
    }));
}

function filterCookies(cookies: RawCookie[], domain: string): RawCookie[] {
    const domainLower = domain.toLowerCase();
    return cookies.filter(c => {
        const cookieDomain = c.domain.toLowerCase().replace(/^\./, "");
        return cookieDomain === domainLower ||
               cookieDomain.endsWith(`.${domainLower}`) ||
               domainLower.endsWith(`.${cookieDomain}`);
    });
}

function toPlaywrightFormat(cookies: RawCookie[]): any[] {
    return cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite === "None" ? "None" : c.sameSite === "Lax" ? "Lax" : c.sameSite === "Strict" ? "Strict" : "None",
    }));
}

async function main() {
    const { domain, all, outFile } = parseArgs();

    if (!domain) {
        console.log("Usage: node --import tsx src/cli/grab-cookies.ts <domain> [--all] [--out file.json]");
        console.log("");
        console.log("Examples:");
        console.log("  grab-cookies.ts uline.com           → .uline-session.json");
        console.log("  grab-cookies.ts basauto.vercel.app   → .basauto-session.json");
        console.log("  grab-cookies.ts uline.com --all      → all cookies (not just domain)");
        console.log("");
        console.log("PREREQUISITE: Chrome must be running with --remote-debugging-port=9222");
        process.exit(1);
    }

    console.log(`Connecting to Chrome on port ${CDP_PORT}...`);
    const wsUrl = await getCDPEndpoint();

    if (!wsUrl) {
        console.error("\nChrome is not running with CDP enabled.");
        console.error("");
        console.error("To enable CDP, close Chrome completely, then restart with these flags:");
        console.error('  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="C:\\Users\\BuildASoil\\AppData\\Local\\Google\\Chrome\\User Data"');
        console.error("");
        console.error("Or run: node --import tsx src/cli/setup-chrome-cdp.ts");
        process.exit(1);
    }

    console.log(`Connected to Chrome CDP at ${wsUrl}`);

    const allCookies = await getAllCookiesViaCDP(wsUrl, domain);
    console.log(`Retrieved ${allCookies.length} total cookies from browser`);

    const cookies = all ? allCookies : filterCookies(allCookies, domain);
    console.log(`Filtered to ${cookies.length} cookies for ${all ? "ALL domains" : domain}`);

    if (cookies.length === 0) {
        console.warn(`\nNo cookies found for ${domain}. Make sure you're logged in to ${domain} in Chrome.`);
        process.exit(1);
    }

    const output = toPlaywrightFormat(cookies);
    const outputPath = outFile || defaultOutputFile(domain);
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    console.log(`\nSaved ${cookies.length} cookies to ${outputPath}`);
    console.log("\nCookies by domain:");
    const byDomain = new Map<string, number>();
    for (const c of cookies) {
        byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1);
    }
    for (const [d, count] of byDomain.entries()) {
        console.log(`  ${d}: ${count}`);
    }

    // Show key cookies for the target domain
    const keyCookies = cookies
        .filter(c => c.domain.includes(domain.split(".")[0]))
        .map(c => {
            const expStr = c.expires <= 0 ? "session" :
                new Date(c.expires * 1000).toISOString().split("T")[0];
            return `  ${c.name.slice(0, 40).padEnd(40)} expires=${expStr}`;
        });
    if (keyCookies.length > 0) {
        console.log(`\nKey ${domain} cookies:`);
        keyCookies.forEach(l => console.log(l));
    }
}

main().catch(err => {
    console.error("Error:", err.message);
    process.exit(1);
});
