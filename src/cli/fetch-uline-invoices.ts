/**
 * @file    src/cli/fetch-uline-invoices.ts
 * @purpose Pull every ULINE invoice PDF out of the ap@ Gmail mailbox, parse the
 *          header (goods, sales tax, shipping/handling, ship via, printed PO) and
 *          write one JSON row per invoice. This is the invoice side of ULINE PO
 *          reconciliation — read only, never writes to Finale.
 *
 * Usage:
 *   node --env-file=.env.local --import tsx src/cli/fetch-uline-invoices.ts
 *   node --env-file=.env.local --import tsx src/cli/fetch-uline-invoices.ts --days 400 --out .tmp/uline-invoices.json
 *
 * @author  Hermia
 * @created 2026-10-15
 * @deps    @googleapis/gmail, gmail/auth, pdf/extractor
 * @env     GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET (tokens: token-ap.json, token.json)
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { gmail as GmailApi } from "@googleapis/gmail";
import { getAuthenticatedClient } from "../lib/gmail/auth";
import { extractPDF } from "../lib/pdf/extractor";

/** One ULINE invoice as printed by Uline (amounts are the invoice's own columns). */
export interface UlineInvoice {
    account: string;
    messageId: string;
    mailDate: string;
    subject: string;
    filename: string;
    invoiceNo: string | null;
    /** Finale PO number printed on the invoice header. */
    poOnInvoice: string | null;
    /** `FEDEX FRT C` = freight collect (carrier bills separately); `FEDEX FRT` / `UPS GROUND` = Uline billed it. */
    shipVia: string | null;
    goods: number | null;
    tax: number | null;
    /** The invoice's SHIPPING/HANDLING column — the $1.50 house charge on a collect shipment, real freight otherwise. */
    handling: number | null;
    due: number | null;
    invDate: string | null;
}

const args = process.argv.slice(2);
const argVal = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] ?? null : null;
};
const DAYS = Number(argVal("--days") || 400);
const OUT = argVal("--out") || path.join(process.cwd(), ".tmp", "uline-invoices.json");

/** Collect PDF parts from a Gmail message payload, at any nesting depth. */
function collectPdfParts(part: any, acc: any[] = []): any[] {
    if (!part) return acc;
    if (part.filename && part.body?.attachmentId && /pdf$/i.test(part.filename)) acc.push(part);
    for (const p of part.parts || []) collectPdfParts(p, acc);
    return acc;
}

function money(text: string, re: RegExp): number | null {
    const m = re.exec(text);
    if (!m) return null;
    const n = Number(m[1].replace(/[,$]/g, ""));
    return Number.isFinite(n) ? n : null;
}

/**
 * Parse one ULINE invoice PDF's header.
 *
 * The header labels concatenate, so `PURCHASE ORDER NO. / SHIP VIA / ORDER DATE`
 * run together as `<customerNo7><poNumber6><shipVia><mm/dd/yy>`. The composite
 * regex is the only reliable way to separate them.
 */
export function parseUlineInvoice(
    account: string,
    msg: { id: string },
    part: { filename: string },
    rawText: string,
    mailDate: string,
    subject: string,
): UlineInvoice {
    const t = rawText.replace(/\s+/g, " ");
    const composite =
        /PURCHASE ORDER NO\.?\s*SHIP VIA[\s\S]{0,200}?(\d{7})(\d{6})\s*([A-Za-z][A-Za-z0-9 .&\-]{1,26}?)(\d{2}\/\d{2}\/\d{2})/.exec(
            t,
        );
    const poFallback = /PURCHASE ORDER NO\.?\s*SHIP VIA[\s\S]{0,120}?(\d{6})/.exec(t);
    return {
        account,
        messageId: msg.id,
        mailDate,
        subject,
        filename: part.filename,
        invoiceNo: /INVOICE #:?\s*(\d{6,})/i.exec(t)?.[1] || null,
        poOnInvoice: composite ? composite[2] : poFallback ? poFallback[1] : null,
        shipVia: composite ? composite[3].trim() : null,
        goods: money(t, /SUB-?TOTAL\s*\$?\s*([\d,]+\.\d{2})/i),
        tax: money(t, /SALES TAX\s*\$?\s*([\d,]+\.\d{2})/i),
        handling: money(t, /SHIPPING\/HANDLING\s*\$?\s*([\d,]+\.\d{2})/i),
        due: money(t, /AMOUNT DUE\s*\$?\s*([\d,]+\.\d{2})/i),
        invDate: /INVOICE DATE:?\s*(\d{2}\/\d{2}\/\d{2,4})/i.exec(t)?.[1] || null,
    };
}

/** True when the invoice ships freight collect, i.e. the carrier bills us separately. */
export function isCollectShipVia(shipVia: string | null | undefined): boolean {
    const s = String(shipVia || "").toUpperCase();
    return /\bFEDEX\s+FRT\s+C\b/.test(s) || /\bCOLLECT\b/.test(s);
}

/** Fetch every ULINE invoice attachment from the given Gmail accounts. */
export async function fetchUlineInvoices(accounts: string[], days: number): Promise<UlineInvoice[]> {
    const out: UlineInvoice[] = [];
    for (const account of accounts) {
        const gmail = GmailApi({ version: "v1", auth: await getAuthenticatedClient(account) });
        const seen = new Set<string>();
        let pageToken: string | undefined;
        do {
            const res: any = await gmail.users.messages.list({
                userId: "me",
                q: `from:accounts.receivable@uline.com has:attachment newer_than:${days}d`,
                maxResults: 100,
                pageToken,
            });
            for (const m of res.data.messages || []) {
                if (!m.id || seen.has(m.id)) continue;
                seen.add(m.id);
                const msg: any = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
                const headers = msg.data.payload?.headers || [];
                const hdr = (n: string) =>
                    headers.find((h: any) => (h.name || "").toLowerCase() === n.toLowerCase())?.value || "";
                for (const part of collectPdfParts(msg.data.payload)) {
                    if (!/Uline_Invoice/i.test(part.filename || "")) continue;
                    const got: any = await gmail.users.messages.attachments.get({
                        userId: "me",
                        messageId: m.id,
                        id: part.body.attachmentId,
                    });
                    const ext = await extractPDF(Buffer.from(got.data.data || "", "base64"));
                    out.push(
                        parseUlineInvoice(account, m, part, ext.rawText || "", hdr("Date"), hdr("Subject")),
                    );
                }
            }
            pageToken = res.data.nextPageToken || undefined;
        } while (pageToken);
    }
    return out;
}

async function main(): Promise<void> {
    const accounts = ["ap", "default"];
    console.log(`Fetching ULINE invoices from ${accounts.join(", ")} (last ${DAYS}d)...`);
    const invoices = await fetchUlineInvoices(accounts, DAYS);
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(invoices, null, 1));
    console.log(`${invoices.length} invoices -> ${OUT}`);
    for (const i of invoices) {
        console.log(
            `${i.account} ${String(i.poOnInvoice || "??").padEnd(7)} | inv ${String(i.invoiceNo).padEnd(10)} | ${String(
                i.shipVia || "?",
            ).padEnd(12)} | goods ${i.goods} tax ${i.tax} ship ${i.handling} due ${i.due}`,
        );
    }
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;
if (isEntrypoint) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
