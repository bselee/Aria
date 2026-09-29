/**
 * @file    audit-amazon-coding.ts
 * @purpose Audit how Amazon card charges are categorised in Finaloop: join the
 *          bank/ledger export to the Amazon Business order-history export, work
 *          out what each charge actually paid for, and report every charge whose
 *          Finaloop category disagrees with the goods behind it.
 *
 *          Amazon charges per shipment, not per order, so a multi-line order can
 *          land as several charges and a single charge can cover only one line of
 *          it. Matching therefore tries the whole-order net first, then falls back
 *          to the individual line net, and never reuses an order or a line.
 *
 *          Read-only: this prints recommendations and writes a review CSV. It
 *          never touches Finaloop or Finale — categories are applied by hand (or
 *          by Finaloop's own import/rules surface).
 *
 * Usage:
 *   node --import tsx src/cli/audit-amazon-coding.ts                     # newest bank + orders exports
 *   node --import tsx src/cli/audit-amazon-coding.ts --bank <path.csv> --orders <path.csv>
 *   node --import tsx src/cli/audit-amazon-coding.ts --out <out.csv>
 *
 * Checks:
 *   miscoded charge   Finaloop category vs the category the items imply
 *   uncoded charge    sitting in "Waiting for your input"
 *   unjoined charge   no order or line in the Amazon export at that amount
 *   split order       one order billed as several charges (reported per charge)
 *
 * @author  Hermia
 * @created 2026-09-29
 * @deps    none (pure CSV)
 * @env     none
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ── Config ───────────────────────────────────────────────────────────────────

/** Where Bill drops Hermes attachments plus the OneDrive sandbox. */
const ATTACHMENT_DIRS = [
    path.join(os.homedir(), "AppData", "Local", "hermes", "attachments"),
    path.join(os.homedir(), "OneDrive", "Desktop", "Sandbox"),
];

/** Default review output, alongside the other reconcile artifacts. */
const DEFAULT_OUT = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "Temp",
    "amz",
    "amazon-coding-review.csv",
);

/** AWS bills through the same "Amazon" merchant string; Software is always right. */
const NON_AMAZON_RETAIL = /web services/i;

/**
 * Category rules, most specific first, matched against the item title. First
 * match wins, then the categories are scored by dollars within an order so a
 * mixed basket lands on its dominant line. Reviewed line by line against the
 * 2026 YTD export on 2026-09-29.
 */
const CATEGORY_RULES: Array<{ category: string; pattern: RegExp }> = [
    { category: "Personal / non-business", pattern: /massage chair|diaper|dvd|zootopia/i },
    { category: "Packaging materials", pattern: /label|mailer|poly bag|thermal postage|receipt paper|tape|shrink wrap|stretch film/i },
    { category: "Repairs", pattern: /garage door|fill valve|valve|camlock|cam lock|hose|adapter|coupler|power cord|fitting|\blid\b|sweeper|hex key|high bay|solar|power supply|\bpsu\b|usb hub|ethernet|vga|fan/i },
    { category: "Supplies & materials", pattern: /respirator|filter cartridge|water filter|wipe|duraprep|cavilon|barrier|sanitizer|star ?san|ph test strip|soap|tissue|scoop|batter|glove|first aid|thermometer|flow meter|scale/i },
    { category: "Office supplies & equipment", pattern: /toner|drum unit|ink cartridge|monitor|desk|organizer|white ?board|printer|camera|computer/i },
];

/** Fallback when nothing in an order matches a rule: office/IT hardware is the norm. */
const DEFAULT_CATEGORY = "Office supplies & equipment";

/** A charge matches an order or line when the amounts agree to within this much. */
const AMOUNT_TOLERANCE = 0.01;

// ── Types ────────────────────────────────────────────────────────────────────

interface BankCharge {
    date: string;
    account: string;
    merchant: string;
    category: string;
    amount: number;
}

interface OrderLine {
    orderId: string;
    orderDate: string;
    po: string;
    asin: string;
    quantity: number;
    title: string;
    net: number;
}

interface Order {
    orderId: string;
    orderDate: string;
    po: string;
    lines: OrderLine[];
    net: number;
}

interface ReviewRow {
    date: string;
    account: string;
    merchant: string;
    current: string;
    amount: number;
    order: string;
    po: string;
    items: string;
    rec: string;
    action: "OK" | "FIX" | "INVESTIGATE";
}

// ── CSV parsing (RFC 4180; Amazon wraps identifiers as ="value") ─────────────

function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    const src = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (inQuotes) {
            if (ch === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ",") {
            row.push(field);
            field = "";
        } else if (ch === "\r") {
            // folded into \n
        } else if (ch === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += ch;
        }
    }
    if (field.length || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

function clean(value: string | undefined): string {
    let v = (value ?? "").trim();
    if (v.startsWith('="') && v.endsWith('"')) v = v.slice(2, -1);
    else if (v.startsWith("=")) v = v.slice(1);
    return v.trim();
}

function num(value: string | undefined): number {
    const v = clean(value);
    if (!v || v.toUpperCase() === "N/A") return 0;
    const n = Number(v.replace(/[$,]/g, ""));
    return Number.isFinite(n) ? n : 0;
}

/** Parse a CSV file into header-keyed records. */
function readRecords(file: string): Array<Record<string, string>> {
    const rows = parseCsv(fs.readFileSync(file, "utf8"));
    const header = rows.shift() ?? [];
    return rows
        .filter((r) => r.some((c) => c.trim().length))
        .map((r) => {
            const rec: Record<string, string> = {};
            header.forEach((h, i) => (rec[clean(h)] = r[i] ?? ""));
            return rec;
        });
}

// ── Export discovery ─────────────────────────────────────────────────────────

/**
 * Newest file in the attachment dirs whose name matches `pattern`, so the audit
 * always runs against the latest export without a path argument.
 */
function newestExport(pattern: RegExp, label: string): string {
    const hits: Array<{ file: string; mtime: number }> = [];
    for (const dir of ATTACHMENT_DIRS) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (!pattern.test(name)) continue;
            const file = path.join(dir, name);
            try {
                hits.push({ file, mtime: fs.statSync(file).mtimeMs });
            } catch {
                // unreadable entry — skip
            }
        }
    }
    if (!hits.length) throw new Error(`No ${label} export found in ${ATTACHMENT_DIRS.join(", ")}`);
    hits.sort((a, b) => b.mtime - a.mtime);
    return hits[0].file;
}

// ── Loading ──────────────────────────────────────────────────────────────────

function loadOrders(file: string): Order[] {
    const byId = new Map<string, Order>();
    for (const r of readRecords(file)) {
        const orderId = clean(r["Order ID"]);
        if (!orderId) continue;
        let order = byId.get(orderId);
        if (!order) {
            order = { orderId, orderDate: clean(r["Order Date"]), po: clean(r["PO Number"]), lines: [], net: 0 };
            byId.set(orderId, order);
        }
        const net = Math.round(num(r["Item Net Total"]) * 100) / 100;
        order.lines.push({
            orderId,
            orderDate: order.orderDate,
            po: order.po,
            asin: clean(r["ASIN"]),
            quantity: num(r["Item Quantity"]),
            title: clean(r["Title"]),
            net,
        });
        order.net = Math.round((order.net + net) * 100) / 100;
    }
    return [...byId.values()];
}

function loadCharges(file: string): BankCharge[] {
    return readRecords(file)
        .filter((r) => clean(r["Merchant"]))
        .map((r) => ({
            date: clean(r["Date"]),
            account: clean(r["Account"]),
            merchant: clean(r["Merchant"]),
            category: clean(r["Category"]),
            amount: Math.abs(num(r["Amount"])),
        }));
}

/** "01/17/2026" -> sortable epoch ms, or NaN when unparseable. */
function chargeTime(date: string): number {
    const m = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2])) : NaN;
}

// ── Categorisation ───────────────────────────────────────────────────────────

/** Category implied by the goods on an order, scored by dollars. */
function recommendCategory(items: Array<{ title: string; net: number }>): string {
    const score = new Map<string, number>();
    for (const item of items) {
        const rule = CATEGORY_RULES.find((r) => r.pattern.test(item.title));
        if (!rule) continue;
        score.set(rule.category, (score.get(rule.category) ?? 0) + Math.max(item.net, 0.01));
    }
    if (!score.size) return DEFAULT_CATEGORY;
    return [...score.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Join each charge to the order or line it paid for. Whole-order net wins (that
 * is the common case); otherwise the individual line net, which is how Amazon
 * bills a split shipment. Both order and line are consumed once, and candidates
 * dated on or before the charge are preferred so returns and re-bills do not
 * steal an earlier match.
 */
function buildReview(charges: BankCharge[], orders: Order[]): ReviewRow[] {
    /** Every review row restates the charge it came from. */
    const base = (c: BankCharge): Omit<ReviewRow, "order" | "po" | "items" | "rec" | "action"> => ({
        date: c.date,
        account: c.account,
        merchant: c.merchant,
        current: c.category,
        amount: c.amount,
    });
    const usedOrders = new Set<string>();
    const usedLines = new Set<OrderLine>();
    const rows: ReviewRow[] = [];

    const closestFirst = <T extends { when: number }>(cands: T[]): T[] =>
        cands.sort((a, b) => {
            const aBefore = a.when <= 0 ? 1 : 0;
            const bBefore = b.when <= 0 ? 1 : 0;
            return aBefore - bBefore || Math.abs(a.when) - Math.abs(b.when);
        });

    for (const charge of charges) {
        if (NON_AMAZON_RETAIL.test(charge.merchant)) {
            rows.push({ ...base(charge), order: "", po: "", items: "AWS", rec: "Software", action: "OK" });
            continue;
        }
        const ct = chargeTime(charge.date);
        const orderHits = orders
            .filter((o) => !usedOrders.has(o.orderId) && Math.abs(o.net - charge.amount) <= AMOUNT_TOLERANCE)
            .map((o) => ({ o, when: chargeTime(o.orderDate) - ct }));
        if (orderHits.length) {
            const { o } = closestFirst(orderHits)[0];
            usedOrders.add(o.orderId);
            o.lines.forEach((l) => usedLines.add(l));
            const rec = recommendCategory(o.lines);
            rows.push({
                ...base(charge),
                order: o.orderId,
                po: o.po,
                items: o.lines.map((l) => `${l.asin} q${l.quantity} ${l.title.slice(0, 44)}`).join("; "),
                rec,
                action: rec === charge.category ? "OK" : "FIX",
            });
            continue;
        }
        const lineHits = orders
            .flatMap((o) => o.lines)
            .filter((l) => !usedLines.has(l) && Math.abs(l.net - charge.amount) <= AMOUNT_TOLERANCE)
            .map((l) => ({ o: l, when: chargeTime(l.orderDate) - ct }));
        if (lineHits.length) {
            const { o: line } = closestFirst(lineHits)[0];
            usedLines.add(line);
            const rec = recommendCategory([line]);
            rows.push({
                ...base(charge),
                order: line.orderId,
                po: line.po,
                items: `${line.asin} q${line.quantity} ${line.title.slice(0, 52)} (one line of a split shipment)`,
                rec,
                action: rec === charge.category ? "OK" : "FIX",
            });
            continue;
        }
        rows.push({
            ...base(charge),
            order: "",
            po: "",
            items: "no order or line in the Amazon export at this amount",
            rec: "REVIEW",
            action: "INVESTIGATE",
        });
    }
    return rows;
}

// ── Output ───────────────────────────────────────────────────────────────────

function money(n: number): string {
    return n.toFixed(2).padStart(9);
}

function printSummary(rows: ReviewRow[], bankFile: string, ordersFile: string, outPath: string): void {
    const fixes = rows.filter((r) => r.action === "FIX");
    const oks = rows.filter((r) => r.action === "OK");
    const open = rows.filter((r) => r.action === "INVESTIGATE");
    const waiting = rows.filter((r) => /waiting for your input/i.test(r.current));

    console.log(`bank   ${bankFile}`);
    console.log(`orders ${ordersFile}\n`);
    console.log(`charges ${rows.length}`);
    console.log(`  correct         ${String(oks.length).padStart(3)}  $${money(oks.reduce((s, r) => s + r.amount, 0))}`);
    console.log(`  miscoded        ${String(fixes.length).padStart(3)}  $${money(fixes.reduce((s, r) => s + r.amount, 0))}`);
    console.log(`  no order match  ${String(open.length).padStart(3)}  $${money(open.reduce((s, r) => s + r.amount, 0))}`);
    if (waiting.length) {
        console.log(`  uncoded ("Waiting for your input") ${waiting.length}  $${money(waiting.reduce((s, r) => s + r.amount, 0))}`);
    }

    const before = new Map<string, number>();
    const after = new Map<string, number>();
    for (const r of rows) {
        before.set(r.current, (before.get(r.current) ?? 0) + r.amount);
        after.set(r.rec, (after.get(r.rec) ?? 0) + r.amount);
    }
    console.log("\n$ by category                       now        should be");
    const keys = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => (before.get(b) ?? 0) - (before.get(a) ?? 0));
    for (const k of keys) {
        console.log(`  ${k.padEnd(30)} ${money(before.get(k) ?? 0)}  ${money(after.get(k) ?? 0)}`);
    }

    if (fixes.length) {
        console.log("\nmiscoded, largest first");
        for (const r of [...fixes].sort((a, b) => b.amount - a.amount)) {
            console.log(`  ${r.date} ${money(r.amount)}  ${r.current.slice(0, 24).padEnd(26)} -> ${r.rec.slice(0, 28).padEnd(30)} ${r.items.slice(0, 52)}`);
        }
    }
    if (open.length) {
        console.log("\nno order or line in the export at that amount");
        for (const r of [...open].sort((a, b) => chargeTime(a.date) - chargeTime(b.date))) {
            console.log(`  ${r.date} ${money(r.amount)}  ${r.current.padEnd(24)} ${r.account.split("|")[0].trim()}`);
        }
    }
    console.log(`\nwrote ${outPath}`);
}

function writeReview(rows: ReviewRow[], outPath: string): void {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const header = ["date", "account", "merchant", "current", "amount", "order", "po", "items", "rec", "action"];
    const esc = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
    const ordered = [...rows].sort((a, b) => (a.action === b.action ? 0 : a.action === "FIX" ? -1 : 1));
    const body = ordered.map((r) =>
        [r.date, r.account, r.merchant, r.current, r.amount.toFixed(2), r.order, r.po, r.items, r.rec, r.action].map(esc).join(","),
    );
    fs.writeFileSync(outPath, [header.map(esc).join(","), ...body].join("\r\n") + "\r\n", "utf8");
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Audit the newest (or given) Finaloop bank export against the newest (or given)
 * Amazon Business order export and report the category disagreements.
 */
function main(): void {
    const argv = process.argv.slice(2);
    const arg = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };

    const bankFile = arg("--bank") ?? newestExport(/^BuildASoil LLC bank transactions.*\.csv$/i, "bank");
    const ordersFile = arg("--orders") ?? newestExport(/^orders_from_.*\.csv$/i, "Amazon orders");
    const outPath = arg("--out") ?? DEFAULT_OUT;

    const charges = loadCharges(bankFile);
    const orders = loadOrders(ordersFile);
    const rows = buildReview(charges, orders);
    printSummary(rows, bankFile, ordersFile, outPath);
    writeReview(rows, outPath);
}

main();
