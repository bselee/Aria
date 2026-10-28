/**
 * Adversarial battery for 8d797b24 — the AP PO-ref fix (three layers).
 *
 * Rule in force: a guard needs an adversarial negative battery before acceptance.
 * Happy-path tests and a green suite prove nothing. This harness asserts the
 * CORRECT behavior; every mismatch is printed as a DEFECT with the real input.
 *
 * Layers exercised:
 *   (c) isPoShaped / validatePoRef   — deterministic shape + existence
 *   (b) extractPOByRegex             — shipment-context post-filter
 *   (a) parseInvoice prompt          — static assertions on the instruction text
 *
 * Run: "/c/Program Files/nodejs/node" --import tsx --env-file=.env.local scripts/ap-po-ref-battery.ts
 */
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { isPoShaped, validatePoRef } from "../src/lib/purchasing/po-ref-validator";
import { extractPOByRegex } from "../src/lib/pdf/invoice-parser";

type Case = { name: string; got: unknown; want: unknown };
const cases: Case[] = [];
const check = (name: string, got: unknown, want: unknown) => {
    cases.push({ name, got, want });
};

// ─── real corpus ─────────────────────────────────────────────────────────────
const db = new Database("aria-local.db", { readonly: true });
const ocr: Record<string, string> = {};
for (const id of ["1a16c4a2f0550ba0", "1a180d27ed8d16fb"]) {
    const row = db
        .prepare("select ocr_raw_text from ap_local_forwards where gmail_message_id = ?")
        .get(id) as { ocr_raw_text?: string } | undefined;
    if (row?.ocr_raw_text) ocr[id] = row.ocr_raw_text;
}
db.close();

// ═══ A. isPoShaped truth table ═══════════════════════════════════════════════
// Real Finale POs
for (const ref of ["125213", "125257", "100347", "113179", "13862", "0264752", "0400234"]) {
    // 13862 / 02xxxxx / 04xxxxx are legacy: shape must NOT claim them, existence must.
    const legacy = ["13862", "0264752", "0400234", "12454", "21135", "38072"];
    check(`A shape ${ref}`, isPoShaped(ref), legacy.includes(ref) ? false : true);
}

// Dropship POs (real spellings from purchase_orders)
for (const ref of [
    "23577107-S-DropshipPO",
    "23320587-DropshipPO",
    "23268687A-DropshipPO",
    "21410811",
]) {
    check(`A shape dropship ${ref}`, isPoShaped(ref), true);
}

// Freight / customer-order refs — must never be shaped
for (const ref of [
    "4798",
    "4803",
    "64058931",
    "64058932",
    "18700362",
    "1330154",
    "000000",
    "ADV ORDER 4798",
]) {
    check(`A reject ${ref}`, isPoShaped(ref), false);
}

// AAA rating estimates: 9 digits then "-1". Shape is "2" + 8 digits, so an
// unanchored dropship regex accepts them. They are NEVER purchase orders.
for (const ref of [
    "278411572-1",
    "269303167-1",
    "270404873-1",
    "276170239-1",
    "268244264-1",
    "269178799-1",
    "123456789-1",
]) {
    check(`A reject estimate ${ref}`, isPoShaped(ref), false);
}

// Over-long digit runs must not pass on a prefix match alone
for (const ref of ["2141081123", "2357710700"]) {
    check(`A reject overlong ${ref}`, isPoShaped(ref), false);
}

// ═══ B. extractPOByRegex on the real statements ═════════════════════════════
// The document that fired the regression: empty P.O.NUMBER box, ADV ORDER 4798.
for (const [id, label] of [
    ["1a16c4a2f0550ba0", "statement 2938 (ADV ORDER 4798)"],
    ["1a180d27ed8d16fb", "statement 2886 (REF# ORDER 4803)"],
] as const) {
    const text = ocr[id];
    check(`B real ${label}: text present`, !!text, true);
    if (text) {
        check(`B real ${label} -> null`, extractPOByRegex(text), null);
    }
}

// ═══ C. false positives: goods-invoice layouts that must still resolve ══════
const positives: Array<[string, string, string]> = [
    ["C plain PO label", "P.O. NUMBER 125213\nTERMS NET 30", "125213"],
    ["C PO hash", "PO#: 125213", "125213"],
    ["C purchase order", "Purchase Order # 125376", "125376"],
    ["C uline your order", "Your Order No. 125213", "125213"],
    ["C coats customer ref", "Customer Ref 125213", "125213"],
    // A PO value on the line below a "SOLD TO" block header is still a PO.
    ["C sold-to above", "SOLD TO\nP.O. NUMBER 125213", "125213"],
    // A city named SOUTH BEND must not read as a sales-order token.
    ["C south bend", "SOUTH BEND, IN 46601\nP.O. NUMBER 125213", "125213"],
    // Tabular header row: value on the next line, header also names INVOICE DATE.
    // (PO in the first column — the layout the header-row branch exists for.)
    ["C header row", "P.O. NUMBER     INVOICE DATE     TERMS\n125213          10/15/26         NET 30", "125213"],
    // Freight document that DOES carry a real PO must still yield it.
    ["C freight with real po", "PRO NUMBER 64058931\nB.L.NUMBER 18700362\nP.O. NUMBER 125213", "125213"],
    ["C pro line above po", "PRO NUMBER 64058931\nP.O. NUMBER 125213", "125213"],
];
for (const [name, text, want] of positives) {
    check(name, extractPOByRegex(text), want);
}

// ═══ D. validatePoRef against the live purchase_orders table ════════════════
(async () => {
    check("D 4798 (customer order)", await validatePoRef("4798"), null);
    check("D 4803 (customer order)", await validatePoRef("4803"), null);
    check("D 64058931 (freight PRO)", await validatePoRef("64058931"), null);
    check("D 278411572-1 (estimate)", await validatePoRef("278411572-1"), null);
    check("D 125213 (real PO)", await validatePoRef("125213"), "125213");
    check("D PO-125213 (prefix)", await validatePoRef("PO-125213"), "125213");
    check("D 0400234 (legacy zero-pad, exists)", await validatePoRef("0400234"), "0400234");
    check("D 0400773 (legacy zero-pad, dangling)", await validatePoRef("0400773"), null);
    // Legacy dropship PO with a lowercase suffix — exists in purchase_orders.
    check(
        "D 4520-DropshipPO (legacy suffix, exists)",
        await validatePoRef("4520-DropshipPO"),
        "4520-DropshipPO",
    );

    // ─── E. corpus contract: the validator must never reject a real PO ──────
    // Every po_number that exists must survive validatePoRef with its DB
    // spelling intact. This is the strongest shape of the rule: no suffix
    // grammar, case form or legacy zero-pad may be nulled out of the ledger.
    {
        const { Client } = await import("pg");
        const { readFileSync } = await import("fs");
        const env = readFileSync(".env.local", "utf8");
        for (const l of env.split(/\r?\n/)) {
            const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
        const pg = new Client({ connectionString: process.env.DATABASE_URL });
        await pg.connect();
        const all = await pg.query(`select po_number from purchase_orders where po_number is not null order by po_number`);
        await pg.end();
        const rejected: string[] = [];
        const respelled: string[] = [];
        for (const row of all.rows as Array<{ po_number: string }>) {
            const out = await validatePoRef(row.po_number);
            if (out === null) rejected.push(row.po_number);
            else if (out !== row.po_number.trim()) respelled.push(`${row.po_number} -> ${out}`);
        }
        // One assertion each, so the report stays readable.
        check(`E corpus ${all.rowCount} real POs — none rejected`, rejected.slice(0, 12), []);
        check(`E corpus — spelling preserved`, respelled.slice(0, 12), []);
        if (rejected.length > 12) console.log(`  (+${rejected.length - 12} more rejected)`);
        if (respelled.length > 12) console.log(`  (+${respelled.length - 12} more respelled)`);
    }

    // ─── verdict ─────────────────────────────────────────────────────────────
    const defects = cases.filter((c) => JSON.stringify(c.got) !== JSON.stringify(c.want));
    console.log(`\n${cases.length} cases, ${defects.length} defect(s)\n`);
    for (const d of defects) {
        const kind = d.name.startsWith("A") ? "SHAPE" : d.name.startsWith("B") ? "EXTRACT" : d.name.startsWith("C") ? "FALSE-POSITIVE" : "VALIDATOR";
        console.log(`DEFECT [${kind}] ${d.name}\n        got  ${JSON.stringify(d.got)}\n        want ${JSON.stringify(d.want)}`);
    }
    if (defects.length === 0) console.log("BATTERY GREEN — PO-ref fix holds on every adversarial case.");
    else console.log(`\nBATTERY RED — ${defects.length} of ${cases.length} cases fail.`);

    // Prompt layer: static assertions (the LLM itself is not deterministically pinnable)
    try {
        const src = readFileSync("src/lib/pdf/invoice-parser.ts", "utf8");
        const hasNullRule = /poNumber[^\n]{0,40}null/i.test(src) && /(ADV\s+ORDER|Order\s*#?)/i.test(src);
        console.log(`\nprompt guard text present: ${hasNullRule ? "yes" : "NO — check the instruction was not reverted"}`);
    } catch (e: any) {
        console.log("\nprompt source unreadable:", e.message);
    }
    process.exit(defects.length === 0 ? 0 : 1);
})().catch((e) => {
    console.error("ERR", e?.message || e);
    process.exit(2);
});
