/**
 * @file    shipment-leg-parser.ts
 * @purpose Parse the `/legs` Telegram command syntax into structured leg records
 *          that can be upserted into po_shipment_legs.
 *
 *          Accepted formats:
 *            /legs PO-1234 1:30000@2026-06-10 2:40000@2026-07-05 3:50000@2026-08-01
 *            /legs PO-1234 1:30k@Jun-10 2:40k@Jul-5 3:50k@Aug-1
 *            /legs PO-1234 1:30,000@06/10 2:40,000@07/05
 *
 *          This module is pure (no I/O). The caller is responsible for the
 *          actual Supabase upsert.
 *
 * @author  Aria
 * @created 2026-05-21
 * @updated 2026-05-21
 * @deps    (none — pure parsing)
 */

export interface ParsedLeg {
    legNumber: number;
    expectedQty: number;
    expectedDate: string; // ISO-8601 date string, YYYY-MM-DD
}

export interface ParsedLegsCommand {
    poNumber: string;
    legs: ParsedLeg[];
    /** Parsing warnings that don't block the command but should be surfaced. */
    warnings: string[];
}

export interface LegsParseError {
    error: string;
}

/**
 * Parse a `/legs` command string into a structured result.
 *
 * @param   raw   - The full command text, including the leading `/legs`
 * @returns ParsedLegsCommand on success, LegsParseError if unrecoverable
 *
 * @example
 * parseLegsCommand("/legs PO-1234 1:30000@2026-06-10 2:40000@2026-07-05")
 * // → { poNumber: "PO-1234", legs: [{legNumber:1, expectedQty:30000, expectedDate:"2026-06-10"}, ...] }
 */
export function parseLegsCommand(raw: string): ParsedLegsCommand | LegsParseError {
    const normalized = raw.trim().replace(/\s+/g, " ");

    // Strip leading /legs (case-insensitive)
    const withoutCmd = normalized.replace(/^\/legs\s*/i, "").trim();
    if (!withoutCmd) {
        return { error: "Missing PO number. Usage: /legs PO-1234 1:30000@2026-06-10 2:40000@2026-07-05" };
    }

    const parts = withoutCmd.split(/\s+/);
    const poNumber = parts[0];
    if (!poNumber) {
        return { error: "Missing PO number." };
    }

    // Validate PO number loosely — just needs to be non-empty and not look like a leg token
    if (/^\d+:\d/.test(poNumber)) {
        return { error: `'${poNumber}' looks like a leg token, not a PO number. Put the PO number first.` };
    }

    const legTokens = parts.slice(1);
    if (legTokens.length === 0) {
        return { error: `No legs provided. Usage: /legs ${poNumber} 1:30000@2026-06-10 2:40000@2026-07-05` };
    }

    const legs: ParsedLeg[] = [];
    const warnings: string[] = [];

    for (const token of legTokens) {
        // Expected: "1:30000@2026-06-10" — separator can be @ or =
        const match = token.match(/^(\d+)[:=]([0-9,kKmM.]+)[@=](.+)$/);
        if (!match) {
            warnings.push(`Skipped unrecognized token: '${token}'. Expected format: legNum:qty@date`);
            continue;
        }

        const [, legStr, qtyStr, dateStr] = match;
        const legNumber = parseInt(legStr, 10);

        if (legNumber < 1) {
            warnings.push(`Leg number must be ≥ 1 (got ${legStr}). Skipped.`);
            continue;
        }
        if (legs.some(l => l.legNumber === legNumber)) {
            warnings.push(`Duplicate leg number ${legNumber}. Second occurrence skipped.`);
            continue;
        }

        const expectedQty = parseQty(qtyStr);
        if (expectedQty === null || expectedQty <= 0) {
            warnings.push(`Could not parse quantity '${qtyStr}' for leg ${legNumber}. Skipped.`);
            continue;
        }

        const expectedDate = parseDate(dateStr);
        if (!expectedDate) {
            warnings.push(`Could not parse date '${dateStr}' for leg ${legNumber}. Skipped.`);
            continue;
        }

        legs.push({ legNumber, expectedQty, expectedDate });
    }

    if (legs.length === 0) {
        return { error: `No valid legs parsed. Check your format: /legs ${poNumber} 1:30000@2026-06-10` };
    }

    // Sort legs by leg number for predictability
    legs.sort((a, b) => a.legNumber - b.legNumber);

    return { poNumber, legs, warnings };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Parse human-friendly quantity strings.
 * Supports: "30000", "30,000", "30k", "30K", "1.5m", "1.5M"
 */
function parseQty(raw: string): number | null {
    const clean = raw.replace(/,/g, "").toLowerCase().trim();
    const kMatch = clean.match(/^([\d.]+)k$/);
    if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1_000);
    const mMatch = clean.match(/^([\d.]+)m$/);
    if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1_000_000);
    const n = parseFloat(clean);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
}

/**
 * Parse flexible date strings into ISO YYYY-MM-DD.
 * Supports:
 *   2026-06-10    → 2026-06-10
 *   06/10         → current-year-06-10
 *   Jun-10        → current-year-06-10
 *   Jun10         → current-year-06-10
 *   June 10       → current-year-06-10
 */
function parseDate(raw: string): string | null {
    const clean = raw.trim();

    // Full ISO: YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
        return isValidDate(clean) ? clean : null;
    }

    // MM/DD or M/D
    const slashMatch = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (slashMatch) {
        const year = slashMatch[3]
            ? (slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3])
            : String(new Date().getFullYear());
        const iso = `${year}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
        return isValidDate(iso) ? iso : null;
    }

    // MonName-DD or MonName DD (e.g., Jun-10, June 10, Jun10)
    const months: Record<string, string> = {
        jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
        jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const monthMatch = clean.match(/^([A-Za-z]{3,9})[-\s]?(\d{1,2})(?:[,\s]+(\d{4}))?$/);
    if (monthMatch) {
        const monthKey = monthMatch[1].toLowerCase().slice(0, 3);
        const month = months[monthKey];
        if (!month) return null;
        const day = monthMatch[2].padStart(2, "0");
        const year = monthMatch[3] ?? String(new Date().getFullYear());
        const iso = `${year}-${month}-${day}`;
        return isValidDate(iso) ? iso : null;
    }

    return null;
}

function isValidDate(iso: string): boolean {
    const d = new Date(iso + "T12:00:00Z");
    return !isNaN(d.getTime());
}

/** Type guard for LegsParseError */
export function isLegsParseError(r: ParsedLegsCommand | LegsParseError): r is LegsParseError {
    return "error" in r;
}
