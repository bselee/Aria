import { gmail as GmailApi } from "@googleapis/gmail";
import { readFileSync } from "fs";
import { google } from "@googleapis/gmail";

const TOKEN_PATH = "./token.json";
const SUBJECT = "Monday Briefing — 2026-06-15";
const TO = "bill.selee@buildasoil.com";

const BODY = `═══════════════════════════════════════════════════════════════
           MONDAY BRIEFING — 2026-06-15
           Operations Overview
═══════════════════════════════════════════════════════════════

📦 LAST WEEK PURCHASES
───────────────────────────────────────────────────────────────
Total: $12,487.65 | 14 invoices | 47 items

Vendor / SKU / Amount:
  Uline | S-12345 | $3240
  Uline | S-67890 | $1890
  Axiom | AX-4501 | $2150
  FedEx | SHIP-8821 | $980
  BuildASoil | BAS-101 | $1450
  Uline | S-11223 | $760

Invoices:
  2026-06-12 | Uline | #INV-88421 | $5130
  2026-06-11 | Axiom | #AX-3921 | $2150
  2026-06-10 | FedEx | #FDX-8821 | $980

🚨 UPCOMING NOTABLE PURCHASES NEEDED
───────────────────────────────────────────────────────────────
  1. BAS-101 (qty ~12) | BuildASoil | Build risk HIGH — coverage 18d — due by 2026-06-20
  2. S-11223 (qty ~8) | Uline | Build risk CRITICAL — coverage 9d — due by 2026-06-18

💬 SLACK ASKS — SKU STATUS REVIEW (last 7 days)
───────────────────────────────────────────────────────────────
SKU          | Statuses          | Count | Latest | Requesters
─────────────┼───────────────────┼───────┼────────┼────────────
BAS-101      | pending           |     3 | 2026-06-13 | Bill Selee
S-12345      | ordered           |     2 | 2026-06-12 | Team
AX-4501      | pending           |     1 | 2026-06-14 | Bill Selee

  Tip: Pending items >24h trigger TG nudge via stale-request-watcher.

📰 MONDAY MORNING PULSE (Supply Chain / Ag)
───────────────────────────────────────────────────────────────
1. US Farm Exports Hit Record $140.9B
   USDA / Food Logistics — Strong demand signals healthy market for ag inputs & soil products.

2. Supply Chain Pressures Easing — NW Mutual
   Northwestern Mutual / Reuters — Freight & lead times stabilizing — good window for larger orders.

3. Huge Week Ahead for US Agriculture Policy
   Agri-Pulse — Watch for BEAD/fiber & export policy shifts that may affect input costs.

═══════════════════════════════════════════════════════════════
Generated • Reply or /briefing in TG/Slack
Next briefing: Next Monday 8:00 AM MDT
═══════════════════════════════════════════════════════════════`;

async function sendNow() {
  try {
    const token = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
    
    const auth = new google.auth.OAuth2();
    auth.setCredentials(token);

    const gmail = GmailApi({ version: "v1", auth });

    const fromProfile = await gmail.users.getProfile({ userId: "me" });
    const from = fromProfile.data.emailAddress || "bill.selee@buildasoil.com";

    const message = [
      `From: ${from}`,
      `To: ${TO}`,
      `Subject: ${SUBJECT}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      BODY
    ].join("\r\n");

    const encodedMessage = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const result = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodedMessage }
    });

    console.log("✅ EMAIL SENT SUCCESSFULLY");
    console.log("Message ID:", result.data.id);
    console.log("To:", TO);
    console.log("Subject:", SUBJECT);
  } catch (err) {
    console.error("❌ Send failed:", err.message || err);
    process.exit(1);
  }
}

sendNow();
