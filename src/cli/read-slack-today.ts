/**
 * @file    read-slack-today.ts
 * @purpose One-shot read of today's Slack messages
 * @author  Hermia
 */
import { WebClient } from "@slack/web-api";
import path from "path";
import { promises as fs } from "fs";

async function main() {
  const envPath = path.resolve(".env.local");
  const envContent = await fs.readFile(envPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    env[key] = val.replace(/^['"]|['"]$/g, "");
  }

  const token = env.SLACK_ACCESS_TOKEN;
  if (!token) { console.error("No SLACK_ACCESS_TOKEN"); process.exit(1); }

  const client = new WebClient(token);
  const channelsRes = await client.conversations.list({ types: "public_channel,private_channel,im", limit: 500 });
  const channels = channelsRes.channels || [];
  const todayUnix = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

  for (const chanName of ["purchase-orders", "purchasing"]) {
    const chan = channels.find((c: any) => c.name === chanName);
    if (!chan || !chan.id) { console.log(`\n=== #${chanName} === not found`); continue; }
    console.log(`\n=== #${chanName} ===`);
    const hist = await client.conversations.history({ channel: chan.id, oldest: String(todayUnix), limit: 100 });
    const msgs = hist.messages || [];
    if (msgs.length === 0) { console.log("  (no messages today)"); continue; }
    msgs.reverse();
    for (const msg of msgs) {
      const ts = new Date(parseFloat(msg.ts as string) * 1000).toLocaleTimeString("en-US", { hour12: false });
      console.log(`[${ts}] <${msg.user || msg.bot_id || "?"}> ${(msg.text || "").substring(0, 600)}`);
      if (msg.thread_ts) {
        try {
          const repl = await client.conversations.replies({ channel: chan.id, ts: msg.thread_ts as string, limit: 20 });
          for (const r of (repl.messages || []).slice(1)) {
            const rts = new Date(parseFloat(r.ts as string) * 1000).toLocaleTimeString("en-US", { hour12: false });
            console.log(`  \u21b3 [${rts}] <${r.user || r.bot_id || "?"}> ${(r.text || "").substring(0, 300)}`);
          }
        } catch { /* skip */ }
      }
    }
  }
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
