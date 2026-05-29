/**
 * @file    browserbase-manager.ts
 * @purpose Browserbase cloud browser session management with free-tier usage controls.
 *          Free tier = 100 sessions/month. This module enforces hard limits,
 *          tracks usage in SQLite, and supports session reuse to minimize count.
 * @author  Hermia
 * @created 2026-05-29
 * @deps    @/lib/storage/local-db, https (stdlib)
 * @env     BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID
 *
 * SESSION BUDGET (free tier):
 *   - Hard block at 95 sessions/month (leaves 5 for emergencies)
 *   - Warning logged at 80 sessions/month
 *   - Session reuse: same task_type within 25 min reuses existing session
 *   - Sessions auto-expire after 30 min (configurable, max 60 min on free tier)
 *
 * USAGE:
 *   const bbManager = BrowserbaseManager.getInstance();
 *   const page = await bbManager.getBrowserPage('cart-filling-uline');
 *   // ... do work ...
 *   await bbManager.releaseSession(page);  // optional: close the page but keep session alive
 *   await bbManager.closeSession('cart-filling-uline');  // fully close session
 */

import { getLocalDb } from '@/lib/storage/local-db';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import https from 'https';

// ── Types ───────────────────────────────────────────────────────────────────

export interface BrowserbaseConfig {
    apiKey: string;
    projectId: string;
    maxSessionsPerMonth?: number;  // default 95 (hard block)
    warnAtSessions?: number;       // default 80
    sessionTimeoutMinutes?: number; // default 25 (reuse window, < 30 min expiry)
    reuseWindowMinutes?: number;   // default 25 (match sessionTimeoutMinutes)
}

interface BbSession {
    id: string;
    connectUrl: string;
    status: string;
}

interface ActiveSession {
    taskId: string;
    bbSessionId: string;
    browser: Browser;
    context: BrowserContext;
    pages: Page[];
    createdAt: number;
    reuseCount: number;
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class BrowserbaseManager {
    private static instance: BrowserbaseManager | null = null;
    private config: BrowserbaseConfig;
    private activeSessions: Map<string, ActiveSession> = new Map();

    private constructor(config: BrowserbaseConfig) {
        this.config = {
            maxSessionsPerMonth: 95,
            warnAtSessions: 80,
            sessionTimeoutMinutes: 25,
            reuseWindowMinutes: 25,
            ...config,
        };
    }

    static getInstance(): BrowserbaseManager {
        if (!BrowserbaseManager.instance) {
            const apiKey = process.env.BROWSERBASE_API_KEY;
            const projectId = process.env.BROWSERBASE_PROJECT_ID;
            if (!apiKey || !projectId) {
                throw new Error('BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID must be set');
            }
            BrowserbaseManager.instance = new BrowserbaseManager({ apiKey, projectId });
        }
        return BrowserbaseManager.instance;
    }

    // ── Usage Tracking ──────────────────────────────────────────────────────

    /**
     * Count sessions created this calendar month.
     */
    private getMonthlyCount(): number {
        const db = getLocalDb();
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);
        const row = db.prepare(
            `SELECT COUNT(*) as cnt FROM browserbase_sessions WHERE created_at >= ?`
        ).get(startOfMonth.toISOString()) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
    }

    /**
     * Check if we can create a new session. Throws if blocked.
     * Returns the current monthly count for logging.
     */
    private checkBudget(): number {
        const count = this.getMonthlyCount();
        if (count >= (this.config.maxSessionsPerMonth ?? 95)) {
            throw new Error(
                `Browserbase budget exhausted: ${count}/${this.config.maxSessionsPerMonth} sessions this month. ` +
                `Using local browser instead. Reset on the 1st.`
            );
        }
        if (count >= (this.config.warnAtSessions ?? 80)) {
            console.warn(
                `[Browserbase] ⚠️ Budget warning: ${count}/${this.config.maxSessionsPerMonth} sessions used this month`
            );
        }
        return count;
    }

    /**
     * Record a new session in the tracking table.
     */
    private recordSession(bbSessionId: string, taskType: string, expiresAt: Date): void {
        const db = getLocalDb();
        db.prepare(
            `INSERT INTO browserbase_sessions (bb_session_id, task_type, expires_at, reason)
             VALUES (?, ?, ?, 'created')`
        ).run(bbSessionId, taskType, expiresAt.toISOString());
    }

    /**
     * Record a session reuse (increment reuse counter).
     */
    private recordReuse(sessionId: string): void {
        const db = getLocalDb();
        db.prepare(
            `UPDATE browserbase_sessions SET reused_count = reused_count + 1 WHERE bb_session_id = ?`
        ).run(sessionId);
    }

    /**
     * Find a reusable session for the same task type that hasn't expired.
     */
    private findReusableSession(taskType: string): ActiveSession | null {
        const now = Date.now();
        const reuseWindowMs = (this.config.reuseWindowMinutes ?? 25) * 60 * 1000;

        for (const [taskId, session] of this.activeSessions.entries()) {
            if (taskType === session.taskId &&
                (now - session.createdAt) < reuseWindowMs) {
                session.reuseCount++;
                this.recordReuse(session.bbSessionId);
                console.log(`[Browserbase] ♻️ Reusing session ${session.bbSessionId} for ${taskType} (reuse #${session.reuseCount})`);
                return session;
            }
        }
        return null;
    }

    // ── Browserbase API ─────────────────────────────────────────────────────

    /**
     * Create a new Browserbase session via REST API.
     * Returns session ID and CDP connect URL.
     */
    private async createBbSession(): Promise<BbSession> {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({ projectId: this.config.projectId });

            const req = https.request(
                {
                    hostname: 'api.browserbase.com',
                    path: '/v1/sessions',
                    method: 'POST',
                    headers: {
                        'x-bb-api-key': this.config.apiKey,
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                    },
                },
                (res) => {
                    let body = '';
                    res.on('data', (chunk) => (body += chunk));
                    res.on('end', () => {
                        if (res.statusCode !== 200 && res.statusCode !== 201) {
                            reject(new Error(`Browserbase API error ${res.statusCode}: ${body.slice(0, 300)}`));
                            return;
                        }
                        try {
                            const data = JSON.parse(body);
                            resolve({
                                id: data.id,
                                connectUrl: data.connectUrl,
                                status: data.status,
                            });
                        } catch (e: any) {
                            reject(new Error(`Failed to parse Browserbase response: ${e.message}`));
                        }
                    });
                }
            );
            req.on('error', reject);
            req.setTimeout(30000, () => { req.destroy(); reject(new Error('Browserbase API timeout')); });
            req.write(postData);
            req.end();
        });
    }

    /**
     * Close a Browserbase session via REST API.
     */
    private async closeBbSession(sessionId: string): Promise<void> {
        return new Promise((resolve) => {
            const req = https.request(
                {
                    hostname: 'api.browserbase.com',
                    path: `/v1/sessions/${sessionId}`,
                    method: 'PUT',
                    headers: {
                        'x-bb-api-key': this.config.apiKey,
                        'Content-Type': 'application/json',
                    },
                },
                (res) => {
                    res.resume(); // drain
                    res.on('end', resolve);
                }
            );
            req.on('error', () => resolve()); // best-effort
            req.setTimeout(10000, () => { req.destroy(); resolve(); });
            req.write(JSON.stringify({ status: 'ENDED' }));
            req.end();
        });
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Get a Playwright Page connected to a Browserbase cloud browser.
     * Reuses sessions for the same taskType within the reuse window.
     *
     * @param taskType - Descriptive name for the task (e.g. 'cart-filling-uline', 'web-research')
     * @returns Playwright Page ready for use
     * @throws Error if budget is exhausted or API fails
     */
    async getBrowserPage(taskType: string): Promise<Page> {
        // Check for reusable session first
        const existing = this.findReusableSession(taskType);
        if (existing) {
            const page = await existing.context.newPage();
            existing.pages.push(page);
            return page;
        }

        // Budget check
        const monthlyCount = this.checkBudget();
        console.log(`[Browserbase] Creating new session for ${taskType} (${monthlyCount + 1}/month)`);

        // Create Browserbase session
        const bbSession = await this.createBbSession();
        console.log(`[Browserbase] Session ${bbSession.id} created, connecting via CDP...`);

        // Connect Playwright to the session
        const browser = await chromium.connectOverCDP(bbSession.connectUrl);
        const contexts = browser.contexts();
        const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
        const page = await context.newPage();

        // Track the session
        const expiresAt = new Date(Date.now() + (this.config.sessionTimeoutMinutes ?? 25) * 60 * 1000);
        this.recordSession(bbSession.id, taskType, expiresAt);

        const activeSession: ActiveSession = {
            taskId: taskType,
            bbSessionId: bbSession.id,
            browser,
            context,
            pages: [page],
            createdAt: Date.now(),
            reuseCount: 0,
        };
        this.activeSessions.set(bbSession.id, activeSession);

        // Set up auto-close on browser disconnect
        browser.on('disconnected', () => {
            this.activeSessions.delete(bbSession.id);
            console.log(`[Browserbase] Session ${bbSession.id} disconnected`);
        });

        return page;
    }

    /**
     * Check if Browserbase is available and within budget.
     */
    isAvailable(): boolean {
        if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
            return false;
        }
        try {
            this.checkBudget();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get current usage stats.
     */
    getUsageStats(): { used: number; limit: number; remaining: number; activeSessions: number } {
        return {
            used: this.getMonthlyCount(),
            limit: this.config.maxSessionsPerMonth ?? 95,
            remaining: (this.config.maxSessionsPerMonth ?? 95) - this.getMonthlyCount(),
            activeSessions: this.activeSessions.size,
        };
    }

    /**
     * Release a page (close it but keep session alive for reuse).
     */
    async releasePage(page: Page): Promise<void> {
        try { await page.close(); } catch { /* best-effort */ }
    }

    /**
     * Close a session completely and disconnect.
     */
    async closeSession(taskId: string): Promise<void> {
        for (const [sessionId, session] of this.activeSessions.entries()) {
            if (session.taskId === taskId) {
                try { await session.browser.close(); } catch { /* best-effort */ }
                await this.closeBbSession(sessionId);
                this.activeSessions.delete(sessionId);
                console.log(`[Browserbase] Session ${sessionId} for ${taskId} closed`);
                break;
            }
        }
    }

    /**
     * Close all active sessions. Call on shutdown.
     */
    async closeAll(): Promise<void> {
        for (const [sessionId, session] of this.activeSessions.entries()) {
            try { await session.browser.close(); } catch { /* best-effort */ }
            await this.closeBbSession(sessionId);
        }
        this.activeSessions.clear();
    }
}
