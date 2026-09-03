/**
 * @file    src/cli/draft-po-from-order-email.ts
 * @purpose Scan bill.selee@ for Uline/Axiom/BFG order emails → print draft-PO
 *          proposals. Optionally create Finale DRAFT POs only when clean.
 *
 *          NEVER auto-commits. --create-drafts still only calls
 *          createDraftPurchaseOrder (draft status). needsReview proposals are
 *          never written to Finale unless --force-draft (still draft, never commit).
 *
 * @author  Hermia
 * @created 2026-08-13
 * @deps    gmail auth (default slot), finale client, pack-size-registry, parser
 * @env     .env.local Gmail + Finale
 *
 * Usage:
 *   npx tsx --env-file=.env.local src/cli/draft-po-from-order-email.ts
 *   npx tsx --env-file=.env.local src/cli/draft-po-from-order-email.ts --days 45
 *   npx tsx --env-file=.env.local src/cli/draft-po-from-order-email.ts --create-drafts
 */
import { getAuthenticatedClient } from "@/lib/gmail/auth";
import { gmail as GmailApi } from "@googleapis/gmail";
import { finaleClient } from "@/lib/finale/client";
import { getPackSizes } from "@/lib/purchasing/pack-size-registry";
import {
  detectVendorOrderEmail,
  htmlToRows,
  parseVendorOrderEmail,
  buildDraftPoProposal,
  type DraftPoProposal,
} from "@/lib/purchasing/vendor-order-email-parser";

function decode(data?: string | null): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function collectBodies(part: any, out: string[] = []): string[] {
  if (!part) return out;
  const mt = (part.mimeType || "").toLowerCase();
  if ((mt === "text/html" || mt === "text/plain") && part.body?.data) out.push(decode(part.body.data));
  (part.parts || []).forEach((p: any) => collectBodies(p, out));
  return out;
}

function hdr(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  return headers.find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase())?.value ?? "";
}

function printProposal(p: DraftPoProposal, subject: string): void {
  console.log("");
  console.log("────────────────────────────────────────────────────────────");
  console.log(subject.slice(0, 72));
  console.log(
    `  vendor=${p.vendor}  PO#=${p.poNumber ?? "—"}  order#=${p.orderNumber ?? "—"}  inv#=${p.invoiceNumber ?? "—"}`,
  );
  console.log(`  RESOLVED (${p.resolved.length}):`);
  for (const r of p.resolved) {
    const pack =
      r.packMultiplier !== 1
        ? `  [pack×${r.packMultiplier} ${r.packSource}: vendor ${r.vendorQuantity} ${r.vendorUom ?? ""}]`
        : `  [${r.vendorUom ?? "uom?"} ×${r.vendorQuantity}]`;
    console.log(
      `    ${r.productId.padEnd(12)} qty=${String(r.quantity).padStart(6)} @ $${r.unitPrice.toFixed(4)}${pack}`,
    );
    console.log(`      ${r.description.slice(0, 60)}`);
  }
  if (p.promoLines.length) {
    console.log(`  PROMO/kit excluded: ${p.promoLines.map((x) => x.vendorItemNumber).join(", ")}`);
  }
  if (p.unresolved.length) {
    console.log(`  UNRESOLVED (${p.unresolved.length}):`);
    for (const u of p.unresolved) {
      console.log(`    ${u.vendorItemNumber.padEnd(12)} qty=${u.quantity}  ${u.reason.slice(0, 50)}`);
    }
  }
  console.log(
    `  money sub=${p.totals.subtotal} tax=${p.salesTax} freight=${p.freight} total=${p.totals.total} reconcile=${p.subtotalReconciles}`,
  );
  console.log(
    p.needsReview
      ? `  >>> needsReview=true — ${p.reviewReasons.join("; ").slice(0, 160)}`
      : "  >>> CLEAN — eligible for Finale DRAFT only (never auto-commit)",
  );
}

/** Known Finale party ids — extend as vendors are confirmed. */
const VENDOR_PARTY: Record<string, string> = {
  Uline: "10083",
  // Axiom / BFG: fill when party ids confirmed — without these, --create-drafts skips
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const days = Number(args.find((a, i) => args[i - 1] === "--days") ?? 30);
  const createDrafts = args.includes("--create-drafts");
  const forceDraft = args.includes("--force-draft");

  const auth = await getAuthenticatedClient("default");
  const gmail = GmailApi({ version: "v1", auth: auth as any });

  const q = [
    `newer_than:${days}d`,
    "(",
    'subject:"ULINE ORDER CONFIRMATION"',
    "OR (from:axiomprint.com subject:Invoice)",
    "OR (from:bfgsupply.com subject:Order)",
    ")",
  ].join(" ");

  console.log(`[draft-po-from-order-email] query: ${q}`);
  console.log(`[draft-po-from-order-email] createDrafts=${createDrafts} forceDraft=${forceDraft}`);
  console.log("[draft-po-from-order-email] POLICY: draft only — never commitDraftPO");

  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: 25 });
  const msgs = list.data.messages ?? [];
  console.log(`[draft-po-from-order-email] ${msgs.length} candidate message(s)`);

  let clean = 0;
  let review = 0;
  let drafted = 0;

  for (const m of msgs) {
    const full = await gmail.users.messages.get({ userId: "me", id: m.id!, format: "full" });
    const headers = (full.data.payload?.headers ?? []) as Array<{ name?: string | null; value?: string | null }>;
    const from = hdr(headers, "From");
    const subject = hdr(headers, "Subject");
    if (!detectVendorOrderEmail(from, subject)) continue;

    const body = htmlToRows(collectBodies(full.data.payload).join("\n"));
    const order = parseVendorOrderEmail(from, subject, body);
    if (!order) continue;

    const skus = order.lines.map((l) => l.vendorItemNumber);
    const packMap = await getPackSizes(skus);
    const packLike = new Map<string, { unitsPerPack: number; packUnit: string }>();
    packMap.forEach((v, k) => {
      packLike.set(k, { unitsPerPack: v.unitsPerPack, packUnit: v.packUnit });
    });

    const validate = async (sku: string) => {
      try {
        return await finaleClient.validateProductExists(sku);
      } catch {
        return false;
      }
    };

    const proposal = await buildDraftPoProposal(order, validate, packLike);
    printProposal(proposal, subject);

    if (proposal.needsReview) review += 1;
    else clean += 1;

    const mayDraft = createDrafts && proposal.resolved.length > 0 && (!proposal.needsReview || forceDraft);
    if (!mayDraft) continue;

    const partyId = VENDOR_PARTY[proposal.vendor];
    if (!partyId) {
      console.log(`  !! no Finale partyId configured for ${proposal.vendor} — skip create`);
      continue;
    }

    const items = proposal.resolved
      .filter((r) => r.quantity > 0)
      .map((r) => ({
        productId: r.productId,
        quantity: r.quantity,
        unitPrice: r.unitPrice,
      }));

    if (items.length === 0) continue;

    const memo = [
      `Email order ${proposal.orderNumber ?? proposal.invoiceNumber ?? "?"}`.trim(),
      proposal.poNumber ? `vendorPO ${proposal.poNumber}` : null,
      "source=order-email-parser",
      "AUTO-DRAFT — review before commit",
    ]
      .filter(Boolean)
      .join(" | ");

    try {
      const result = await finaleClient.createDraftPurchaseOrder(partyId, items, memo);
      drafted += 1;
      console.log(`  ✓ DRAFT created orderId=${result.orderId} url=${result.finaleUrl}`);
      if (result.duplicateWarnings?.length) {
        console.log(`  ⚠ duplicates: ${result.duplicateWarnings.join("; ")}`);
      }
    } catch (e: any) {
      console.error(`  ✗ createDraft failed: ${e?.message ?? e}`);
    }
  }

  console.log("");
  console.log(
    `[draft-po-from-order-email] done clean=${clean} needsReview=${review} draftsCreated=${drafted}`,
  );
}

main().catch((e) => {
  console.error("FATAL", e?.message ?? e);
  process.exit(1);
});
