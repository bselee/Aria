/**
 * @file    src/lib/ops/crash-loop-detector.ts
 * @purpose Detect and alert on PM2 crash loops for aria-bot.
 *          Checks agent_heartbeats for rapid restart patterns and sends
 *          a Telegram message to Will when crash loop is detected.
 * @author  Hermia
 * @created 2026-05-28
 * @deps    @/lib/db, telegraf
 */

import { createClient } from "@/lib/db";
import type { Telegraf } from "telegraf";
import { criticalAlert } from "@/lib/intelligence/alert-gate";

const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const CRASH_LOOP_THRESHOLD = 3; // 3+ restarts in window = crash loop

/**
 * Detect if aria-bot has restarted 3+ times in the last 5 minutes
 * and send a Telegram alert to Will if so.
 *
 * Called once on bot boot, after OpsManager initialization.
 * Non-fatal — all failures are silently caught.
 */
export async function detectAndAlertCrashLoop(bot: Telegraf): Promise<void> {
    try {
        const db = createClient();
        if (!db) return;

        const windowStart = new Date(Date.now() - CRASH_LOOP_WINDOW_MS).toISOString();

        // Count recent 'starting' heartbeats (proxy for restarts)
        const { data: heartbeats, error } = await db
            .from("agent_heartbeats")
            .select("heartbeat_at, status, metadata")
            .eq("agent_name", "ops-manager")
            .eq("status", "starting")
            .gte("heartbeat_at", windowStart)
            .order("heartbeat_at", { ascending: false });

        if (error) {
            console.warn(`[CrashLoop] Supabase query failed (non-fatal): ${error.message}`);
            return;
        }

        const restartCount = heartbeats?.length || 0;

        if (restartCount >= CRASH_LOOP_THRESHOLD) {
            const chatId = process.env.TELEGRAM_CHAT_ID;
            if (!chatId) {
                console.warn(`[CrashLoop] Crash loop detected (${restartCount} restarts in 5m) but no TELEGRAM_CHAT_ID`);
                return;
            }

            const alert = [
                `🚨 <b>CRASH LOOP DETECTED</b>`,
                ``,
                `aria-bot has restarted <b>${restartCount} times</b> in the last 5 minutes.`,
                ``,
                `Check PM2 logs: \`pm2 logs aria-bot\``,
            ].join("\n");

            try {
                await criticalAlert(bot, chatId, alert, { parse_mode: "HTML" });
                console.log(`[CrashLoop] 🚨 Alerted Will: ${restartCount} restarts in 5m`);
            } catch (err: any) {
                console.warn(`[CrashLoop] Failed to send Telegram alert: ${err.message}`);
            }
        } else {
            console.log(`[CrashLoop] ✅ Boot clean (${restartCount} recent restarts in 5m)`);
        }

        // Record this boot's heartbeat
        await db.from("agent_heartbeats").insert({
            agent_name: "ops-manager",
            heartbeat_at: new Date().toISOString(),
            status: "starting",
            metadata: { restartCount, windowStart },
            updated_at: new Date().toISOString(),
        });

    } catch (err: any) {
        console.warn(`[CrashLoop] Detection failed (non-fatal): ${err.message}`);
    }
}
