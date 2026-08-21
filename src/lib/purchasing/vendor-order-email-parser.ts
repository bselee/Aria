/**
 * @file    src/lib/purchasing/vendor-order-email-parser.ts
 * @purpose Parse Uline / Axiom / BFG order+invoice emails into Finale-ready
 *          DRAFT-PO proposals. Never auto-commits.
 *
 *          WHY (2026-08-13): online Playwright ordering abandoned. Vendors email
 *          clear order confirmations/invoices to bill.selee@. Aria was ignoring them.
 *
 *          SKU (measured): Uline item # == Finale SKU; Axiom Job Name == Finale SKU.
 *          BFG item # often needs mapping (HGC724946 missing 2026-08-13).
 *
 *          UOM (Bill, 2026-08-13): "uline item numbers mostly correlate, problem
 *          outliers and parsing eaches from ulines cases… inventory is messy."
 *          Pack conversion is NEVER silent: sku_pack_sizes + description (N/CS)
 *          produce a suggested each-qty, always needsReview when multiplier ≠ 1.
 *
 *          Contract: draft PO only. Unresolved SKUs preserved raw. Subtotal must
 *          reconcile or needsReview. Promo/kit components excluded from PO lines.
 *
 * @author  Hermia
 * @created 2026-08-13
 * @deps    none (pure parse); pack map + Finale validator injected by caller
 * @env     none
 */

export interface ParsedOrderLine {
  vendorItemNumber: string;
  description: string;
  quantity: number;
  /** Vendor UOM: EA/RL/KT/CS etc. Null when not printed. */
  unitOfMeasure: string | null;
  /** From description e.g. "(10/CS)" → 10. */
  caseSizeHint: number | null;
  unitPrice: number;
  extendedPrice: number;
  isNoCharge: boolean;
  isKitComponent: boolean;
  taxable: boolean;
}

export interface ParsedOrderTotals {
  subtotal: number | null;
  salesTax: number | null;
  shipping: number | null;
  total: number | null;
}

export interface ParsedVendorOrder {
  vendor: "Uline" | "Axiom Print" | "BFG Supply";
  orderNumber: string | null;
  invoiceNumber: string | null;
  poNumber: string | null;
  customerNumber: string | null;
  orderDate: string | null;
  shipVia: string | null;
  terms: string | null;
  lines: ParsedOrderLine[];
  totals: ParsedOrderTotals;
  warnings: string[];
}

export interface DraftPoProposal {
  vendor: string;
  poNumber: string | null;
  orderNumber: string | null;
  invoiceNumber: string | null;
  resolved: Array<{
    productId: string;
    quantity: number;
    unitPrice: number;
    description: string;
    vendorQuantity: number;
    vendorUom: string | null;
    packMultiplier: number;
    packSource: "none" | "description_hint" | "sku_pack_sizes" | "vendor_uom_ea";
  }>;
  unresolved: Array<{
    vendorItemNumber: string;
    description: string;
    quantity: number;
    unitPrice: number;
    reason: string;
  }>;
  promoLines: Array<{ vendorItemNumber: string; description: string; quantity: number }>;
  totals: ParsedOrderTotals;
  freight: number | null;
  salesTax: number | null;
  needsReview: boolean;
  reviewReasons: string[];
  subtotalReconciles: boolean;
}

export type SkuValidator = (sku: string) => Promise<boolean>;

/** Minimal pack-size row (matches PackSizeRecord shape). */
export interface PackSizeLike {
  unitsPerPack: number;
  packUnit: string;
}

function num(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const cleaned = raw.replace(/[$,\s]/g, "").trim();
  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const v = Number.parseFloat(cleaned);
  return Number.isFinite(v) ? v : null;
}

/** Pull "(10/CS)" / "(12/CS)" style case hints from description text. */
export function extractCaseSizeHint(description: string): number | null {
  const m = description.match(/\((\d+)\s*\/\s*CS\)/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return n > 1 ? n : null;
}

/**
 * Convert Gmail HTML body into pipe-delimited rows (preserves table cells).
 */
export function htmlToRows(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(tr|div|p|table)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

function maybeHtml(body: string): string {
  return /<[a-z][\s\S]*>/i.test(body) ? htmlToRows(body) : body;
}

/**
 * Parse Uline ORDER CONFIRMATION.
 * Item SKUs may be S-445, S-13505B, S-13505B-JUG, S-13505CAP.
 */
export function parseUlineConfirmation(subject: string, body: string): ParsedVendorOrder {
  const text = maybeHtml(body);
  const lines = text.split("\n");
  const warnings: string[] = [];

  const subjOrder = subject.match(/ORDER\s+CONFIRMATION\s*#\s*(\d{6,})/i)?.[1] ?? null;
  const subjPo = subject.match(/PO\s*#\s*(\d{3,})/i)?.[1] ?? null;
  const bodyOrder = text.match(/ORDER\s*#\s*(\d{6,})/i)?.[1] ?? null;
  const bodyPo = text.match(/PO\s*#\s*(\d{3,})/i)?.[1] ?? null;
  const orderNumber = subjOrder ?? bodyOrder;
  const poNumber = subjPo ?? bodyPo;
  if (subjOrder && bodyOrder && subjOrder !== bodyOrder) {
    warnings.push(`order number disagrees: subject ${subjOrder} vs body ${bodyOrder}`);
  }

  let customerNumber: string | null = null;
  let shipVia: string | null = null;
  let orderDate: string | null = null;
  let terms: string | null = null;
  const hdrIdx = lines.findIndex((l) => /CUSTOMER NUMBER/i.test(l) && /SHIP VIA/i.test(l));
  if (hdrIdx >= 0 && hdrIdx + 1 < lines.length) {
    const cells = lines[hdrIdx + 1].split("|").map((c) => c.trim());
    customerNumber = cells[0] || null;
    shipVia = cells[1] || null;
    orderDate = cells[2] || null;
    terms = cells[4] || null;
  }

  // Real SKUs: S-445, H-4986, S-13505B, S-13505B-JUG, S-13505CAP
  const itemRow =
    /^([\d,]+)\s*\|\s*([A-Z]{2,3})\s*\|\s*([A-Z]{1,2}-[A-Z0-9-]{2,20})\s*\|\s*(.+?)\s*\|\s*([\d,]*\.?\d+)\s*\|\s*([\d,]*\.?\d+)\s*\|?\s*(T)?\s*\|?/i;

  const parsed: ParsedOrderLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(itemRow);
    if (!m) continue;
    const qty = num(m[1]);
    const unitPrice = num(m[5]);
    const ext = num(m[6]);
    if (qty === null || unitPrice === null || ext === null) {
      warnings.push(`unparseable numbers on item row: ${lines[i].slice(0, 80)}`);
      continue;
    }
    const marker = lines[i + 1] ?? "";
    const isPromo = /THIS ITEM AT NO CHARGE/i.test(marker);
    const isKitPart = /PART OF KIT/i.test(marker);
    const uom = m[2].toUpperCase();
    const desc = m[4].trim();
    parsed.push({
      vendorItemNumber: m[3].toUpperCase().trim(),
      description: desc,
      quantity: qty,
      unitOfMeasure: uom,
      caseSizeHint: extractCaseSizeHint(desc),
      unitPrice,
      extendedPrice: ext,
      isNoCharge: isPromo || isKitPart || (unitPrice === 0 && ext === 0),
      isKitComponent: isKitPart,
      taxable: Boolean(m[7]),
    });
  }
  if (parsed.length === 0) warnings.push("no item rows recognised");

  const labelled = (label: RegExp): number | null => {
    for (let i = 0; i < lines.length; i++) {
      if (!label.test(lines[i])) continue;
      const inline = lines[i].split("|").map((c) => c.trim()).filter(Boolean);
      for (const cell of inline.slice(1)) {
        const v = num(cell);
        if (v !== null) return v;
      }
      const next = num((lines[i + 1] ?? "").replace(/\|/g, "").trim());
      if (next !== null) return next;
    }
    return null;
  };

  return {
    vendor: "Uline",
    orderNumber,
    invoiceNumber: null,
    poNumber,
    customerNumber,
    orderDate,
    shipVia,
    terms,
    lines: parsed,
    totals: {
      subtotal: labelled(/SUB-?TOTAL/i),
      salesTax: labelled(/SALES TAX/i),
      shipping: labelled(/SHIPPING\s*\/?\s*HANDLING/i),
      total: labelled(/^\s*TOTAL\b/i),
    },
    warnings,
  };
}

/**
 * Parse Axiom Print invoice email. Product id = Job Name (e.g. GBB07).
 */
export function parseAxiomInvoice(subject: string, body: string): ParsedVendorOrder {
  const text = maybeHtml(body);
  const warnings: string[] = [];

  const invoiceNumber =
    subject.match(/Invoice\s+(INV\d+)/i)?.[1] ??
    text.match(/INVOICE:\s*\|?\s*(INV\d+)/i)?.[1] ??
    null;

  const jobName = text.match(/Job Name:\s*\|?\s*([A-Z0-9][A-Z0-9._-]{2,})/i)?.[1]?.trim() ?? null;
  const balance = num(text.match(/BALANCE:\s*\|?\s*\$?([\d,]+\.?\d*)/i)?.[1] ?? null);
  const dateStr = text.match(/DATE:\s*\|?\s*([A-Z][a-z]{2}\s+\d{1,2},\s*\d{4})/i)?.[1] ?? null;
  const poNumber = text.match(/PO\s*#:\s*\|?\s*(\d{3,})/i)?.[1] ?? null;

  // Live Axiom HTML sometimes states qty near product specs
  const qty =
    num(text.match(/(?:QUANTITY|QTY|Quantity)\s*:?\s*\|?\s*([\d,]+)/i)?.[1] ?? null) ??
    num(text.match(/\b([\d,]+)\s*(?:labels|pcs|pieces|rolls)\b/i)?.[1] ?? null);

  const spec = (label: string): string | null =>
    text.match(new RegExp(label + ":\\s*\\|?\\s*([^|\\n]+)", "i"))?.[1]?.trim() ?? null;
  const descParts = [spec("Product"), spec("Size"), spec("Material")].filter(Boolean);
  const description = descParts.length > 0 ? descParts.join(", ") : "Axiom print order";

  if (qty === null) warnings.push("quantity not stated on invoice — must be entered by hand");
  if (!jobName) warnings.push("no Job Name found — cannot identify the product");
  if (balance === null) warnings.push("no BALANCE amount found");

  const lines: ParsedOrderLine[] = jobName
    ? [
        {
          vendorItemNumber: jobName.toUpperCase(),
          description,
          quantity: qty ?? 0,
          unitOfMeasure: "EA",
          caseSizeHint: null,
          unitPrice: qty && balance !== null ? Number((balance / qty).toFixed(4)) : (balance ?? 0),
          extendedPrice: balance ?? 0,
          isNoCharge: false,
          isKitComponent: false,
          taxable: false,
        },
      ]
    : [];

  return {
    vendor: "Axiom Print",
    orderNumber: null,
    invoiceNumber,
    poNumber,
    customerNumber: null,
    orderDate: dateStr,
    shipVia: null,
    terms: null,
    lines,
    totals: { subtotal: balance, salesTax: null, shipping: null, total: balance },
    warnings,
  };
}

/**
 * Parse BFG Supply order confirmation (bfgweborders@bfgsupply.com).
 * Real example 2026-08-12 Order# 3259787: Item HGC724946, qty 80, "(10/CS)".
 */
export function parseBfgOrder(subject: string, body: string): ParsedVendorOrder {
  const text = maybeHtml(body);
  const lines = text.split("\n");
  const warnings: string[] = [];

  const orderNumber =
    subject.match(/Order\s*#?\s*:?\s*(\d{5,})/i)?.[1] ??
    text.match(/Order\s*#?\s*:?\s*(\d{5,})/i)?.[1] ??
    null;
  const customerNumber = text.match(/Customer\s*#?\s*:?\s*\|?\s*(\d{4,})/i)?.[1] ?? null;
  const poNumber =
    text.match(/Customer\s*PO\s*#?\s*:?\s*\|?\s*(\d{3,}|[A-Z0-9-]+)/i)?.[1] ?? null;
  // Empty PO cell often leaves next label — reject non-numeric garbage
  const poClean =
    poNumber && /^\d{3,}$/.test(poNumber) ? poNumber : poNumber && !/phone|comment|detail/i.test(poNumber) ? poNumber : null;

  // Row: qty | item# | description | unit | ext
  // HGC724946 style Hydrofarm/BFG codes
  const itemRow =
    /^([\d,]+)\s*\|\s*([A-Z]{2,6}\d{4,}[A-Z0-9]*)\s*\|\s*(.+?)\s*\|\s*([\d,]*\.?\d+)\s*\|\s*([\d,]*\.?\d+)/i;

  const parsed: ParsedOrderLine[] = [];
  for (const line of lines) {
    const m = line.match(itemRow);
    if (!m) continue;
    // Skip header-ish
    if (/^qty$/i.test(m[1]) || /item/i.test(m[2])) continue;
    const qty = num(m[1]);
    const unitPrice = num(m[4]);
    const ext = num(m[5]);
    if (qty === null || unitPrice === null || ext === null) continue;
    const desc = m[3].trim();
    parsed.push({
      vendorItemNumber: m[2].toUpperCase().trim(),
      description: desc,
      quantity: qty,
      unitOfMeasure: extractCaseSizeHint(desc) ? "CS" : null,
      caseSizeHint: extractCaseSizeHint(desc),
      unitPrice,
      extendedPrice: ext,
      isNoCharge: unitPrice === 0 && ext === 0,
      isKitComponent: false,
      taxable: false,
    });
  }

  // Fallback: single-line layout without pipes (screenshot-style plain text)
  if (parsed.length === 0) {
    const loose = text.match(
      /(\d+)\s+([A-Z]{2,6}\d{4,}[A-Z0-9]*)\s+(.+?)\s+([\d.]+)\s+([\d,.]+)/i,
    );
    if (loose) {
      const qty = num(loose[1]);
      const unitPrice = num(loose[4]);
      const ext = num(loose[5]);
      if (qty !== null && unitPrice !== null && ext !== null) {
        const desc = loose[3].trim();
        parsed.push({
          vendorItemNumber: loose[2].toUpperCase(),
          description: desc,
          quantity: qty,
          unitOfMeasure: extractCaseSizeHint(desc) ? "CS" : null,
          caseSizeHint: extractCaseSizeHint(desc),
          unitPrice,
          extendedPrice: ext,
          isNoCharge: false,
          isKitComponent: false,
          taxable: false,
        });
      }
    }
  }

  if (parsed.length === 0) warnings.push("no BFG item rows recognised");

  const money = (label: RegExp): number | null => {
    const re = new RegExp("(?:^|\\n)\\s*" + label.source + "\\s*:?\\s*\\|?\\s*\\$?([\\d,]+\\.\\d{2})", "gim");
    let last: number | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const v = num(m[1]);
      if (v !== null) last = v;
    }
    return last;
  };

  // Total must not match "Sub Total" / "Order Sub Total"
  const totalOnly = (): number | null => {
    let last: number | null = null;
    for (const line of text.split("\n")) {
      if (/sub\s*total/i.test(line)) continue;
      const m = line.match(/Total\s*:?\s*\|?\s*\$?([\d,]+\.\d{2})/i);
      if (m) {
        const v = num(m[1]);
        if (v !== null) last = v;
      }
    }
    return last;
  };

  return {
    vendor: "BFG Supply",
    orderNumber,
    invoiceNumber: null,
    poNumber: poClean,
    customerNumber,
    orderDate: null,
    shipVia: null,
    terms: null,
    lines: parsed,
    totals: {
      subtotal: money(/Order\s+Sub\s*Total/) ?? money(/Sub\s*Total/),
      salesTax: money(/Tax/),
      shipping: money(/Shipping/),
      total: totalOnly(),
    },
    warnings,
  };
}

/**
 * Decide pack multiplier for vendor qty → Finale eaches.
 *
 * Policy (Bill: messy inventory, eaches-from-cases is the hard problem):
 * - EA/RL with no case hint → multiplier 1 (vendor already in eaches/rolls)
 * - description (N/CS) → N (description wins when explicit)
 * - UOM CS/KT/PK + sku_pack_sizes → registry unitsPerPack
 * - UOM CS/KT/PK without registry → multiplier 1 + review reason (cannot convert)
 * Any multiplier ≠ 1 ALWAYS needs human review before draft commit.
 */
export function resolvePackMultiplier(
  line: ParsedOrderLine,
  pack: PackSizeLike | null | undefined,
): { multiplier: number; source: DraftPoProposal["resolved"][0]["packSource"]; note?: string } {
  const uom = (line.unitOfMeasure ?? "").toUpperCase();
  const packish = /^(CS|KT|PK|CA|CASE|KIT|PACK)$/.test(uom);

  if (line.caseSizeHint && line.caseSizeHint > 1) {
    return { multiplier: line.caseSizeHint, source: "description_hint" };
  }

  if (uom === "EA" || uom === "RL" || uom === "PR") {
    return { multiplier: 1, source: "vendor_uom_ea" };
  }

  if (packish && pack && pack.unitsPerPack > 1) {
    return { multiplier: pack.unitsPerPack, source: "sku_pack_sizes" };
  }

  if (packish && (!pack || pack.unitsPerPack <= 1)) {
    return {
      multiplier: 1,
      source: "none",
      note: `UOM ${uom} looks like packs but no pack-size registry entry — qty left as printed`,
    };
  }

  // Unknown UOM: if registry exists, surface as candidate but still review
  if (pack && pack.unitsPerPack > 1) {
    return {
      multiplier: 1,
      source: "none",
      note: `registry has ${pack.unitsPerPack}/${pack.packUnit} for this SKU but vendor UOM is "${uom || "?"}" — not auto-applied`,
    };
  }

  return { multiplier: 1, source: "none" };
}

/**
 * Build a draft-PO proposal. Never commits. Never invents SKUs.
 *
 * @param order - parsed vendor email
 * @param validate - Finale product exists check
 * @param packSizes - optional map sku → pack size from sku_pack_sizes
 */
export async function buildDraftPoProposal(
  order: ParsedVendorOrder,
  validate: SkuValidator,
  packSizes?: Map<string, PackSizeLike>,
): Promise<DraftPoProposal> {
  const resolved: DraftPoProposal["resolved"] = [];
  const unresolved: DraftPoProposal["unresolved"] = [];
  const promoLines: DraftPoProposal["promoLines"] = [];
  const reviewReasons: string[] = [];

  for (const line of order.lines) {
    if (line.isNoCharge) {
      promoLines.push({
        vendorItemNumber: line.vendorItemNumber,
        description: line.description,
        quantity: line.quantity,
      });
      continue;
    }

    let exists = false;
    let failure = "";
    try {
      exists = await validate(line.vendorItemNumber);
    } catch (e: unknown) {
      failure = `Finale lookup failed: ${(e as Error)?.message ?? String(e)}`;
    }

    if (!exists) {
      unresolved.push({
        vendorItemNumber: line.vendorItemNumber,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        reason: failure || "vendor item number is not a Finale product — needs mapping",
      });
      continue;
    }

    const pack = packSizes?.get(line.vendorItemNumber) ?? null;
    const { multiplier, source, note } = resolvePackMultiplier(line, pack);
    if (note) reviewReasons.push(`${line.vendorItemNumber}: ${note}`);
    if (multiplier !== 1) {
      reviewReasons.push(
        `${line.vendorItemNumber}: pack×${multiplier} (${source}) — vendor ${line.quantity} ${line.unitOfMeasure ?? "u"} → ${line.quantity * multiplier} eaches @ $${(line.unitPrice / multiplier).toFixed(4)}; confirm before draft`,
      );
    }

    resolved.push({
      productId: line.vendorItemNumber,
      quantity: line.quantity * multiplier,
      unitPrice: multiplier > 1 ? Number((line.unitPrice / multiplier).toFixed(6)) : line.unitPrice,
      description: line.description,
      vendorQuantity: line.quantity,
      vendorUom: line.unitOfMeasure,
      packMultiplier: multiplier,
      packSource: source,
    });
  }

  const t = order.totals;
  const lineSum = order.lines
    .filter((l) => !l.isNoCharge)
    .reduce((s, l) => s + l.extendedPrice, 0);
  const subtotalReconciles =
    t.subtotal !== null && Math.abs(lineSum - t.subtotal) <= 0.02;

  if (unresolved.length > 0) {
    reviewReasons.push(`${unresolved.length} line(s) not mapped to a Finale product`);
  }
  if (!subtotalReconciles) {
    reviewReasons.push(
      t.subtotal === null
        ? "vendor subtotal not found — cannot verify line math"
        : `line sum ${lineSum.toFixed(2)} does not match printed subtotal ${t.subtotal.toFixed(2)}`,
    );
  }
  if (resolved.length === 0) reviewReasons.push("no priced, resolvable lines");
  if (resolved.some((r) => r.quantity <= 0)) reviewReasons.push("a resolved line has no quantity");
  for (const w of order.warnings) reviewReasons.push(w);

  // Dedup review reasons
  const uniqueReasons = Array.from(new Set(reviewReasons));

  return {
    vendor: order.vendor,
    poNumber: order.poNumber,
    orderNumber: order.orderNumber,
    invoiceNumber: order.invoiceNumber,
    resolved,
    unresolved,
    promoLines,
    totals: order.totals,
    freight: t.shipping,
    salesTax: t.salesTax,
    needsReview: uniqueReasons.length > 0,
    reviewReasons: uniqueReasons,
    subtotalReconciles,
  };
}

/**
 * Classify which vendor parser to use from From/Subject.
 * Returns null when the message is not a supported order/invoice email.
 */
export function detectVendorOrderEmail(
  from: string,
  subject: string,
): "uline" | "axiom" | "bfg" | null {
  const f = from.toLowerCase();
  const s = subject.toLowerCase();
  // Payment confirmations are not order/invoice sources (no line economics).
  if (/paid\s+\$|paid successfully|payment received/i.test(subject)) return null;
  if (/uline/.test(f) || /uline order confirmation/i.test(subject)) return "uline";
  if (/axiomprint|axiom/.test(f) && /invoice/i.test(s)) return "axiom";
  if (/bfgsupply|bfg/.test(f) && /order/i.test(s)) return "bfg";
  return null;
}

/** Parse using detector. */
export function parseVendorOrderEmail(
  from: string,
  subject: string,
  body: string,
): ParsedVendorOrder | null {
  const kind = detectVendorOrderEmail(from, subject);
  if (kind === "uline") return parseUlineConfirmation(subject, body);
  if (kind === "axiom") return parseAxiomInvoice(subject, body);
  if (kind === "bfg") return parseBfgOrder(subject, body);
  return null;
}
