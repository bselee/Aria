# Receivings Panel Audit Fixes — Implementation Plan

> **For Hermes:** Implement these tasks sequentially — they all touch the same files and must not conflict.

**Goal:** Make the Receivings panel invoice-to-PO matching interface human-usable per the dashboard audit findings: plain-language reasoning, softer actions, hidden alternatives, structured comparison, and $0 invoice explanation.

**Architecture:** Four focused changes to `InvoicePOMatcher.tsx` and one API change to `receivings/route.ts`. All are incremental refinements on the already-built three-section layout (Ready to Match / Needs Review / Auto-Matched).

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Next.js 14 API routes, PostgREST

---

## Current State (baseline)

File: `src/components/dashboard/InvoicePOMatcher.tsx` (~300 lines)
- Three sections: Ready to Match (compact), Needs Review (detailed), Auto-Matched
- Each row shows: score%, invoice#, vendor, date, $, → PO, [Match] button
- Detail rows show: match reasons (small gray text), line items, alt candidate pills

File: `src/app/api/dashboard/receivings/route.ts` (~900 lines)
- `extractLineItems()` helper already extracts SKU/qty/description from OCR
- `matchSuggestions` already include `invoiceLineItems`

---

## Task 1: Plain-language confidence labels + softer buttons

**Objective:** Replace raw percentage badges with human-readable categories and change action buttons from "Match → PO" to "Review match"

**Files:**
- Modify: `src/components/dashboard/InvoicePOMatcher.tsx`

**What to change:**

1. Replace the percentage badge logic. Instead of showing `84%` as a number, show a category label:
   - ≥80% → green pill: `High`
   - 70-79% → amber pill: `Good`
   - 50-69% → zinc pill: `Low`
   - <50% → `—`

2. Change the action button text:
   - Ready section: `Match → PO 124798` → `Review match`
   - Review section: `Match` → `Compare`
   - Auto-matched: `Approve` stays as `Approve`

3. Update the section header labels:
   - "READY TO MATCH" → "High confidence"
   - "NEEDS REVIEW" → "Review recommended"
   - "AUTO-MATCHED" → "Auto-matched · ready to approve"

**Code changes in `InvoicePOMatcher.tsx`:**

Replace the score display block (lines 155-167):

```tsx
{/* Score badge — category label instead of percentage */}
{isAuto ? (
    <Check className="w-3 h-3 text-emerald-500 shrink-0" />
) : best && best.score >= 80 ? (
    <span className="text-[9px] font-mono font-bold px-1 py-px rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400 shrink-0">High</span>
) : best && best.score >= 70 ? (
    <span className="text-[9px] font-mono font-bold px-1 py-px rounded border border-amber-500/30 bg-amber-500/10 text-amber-400 shrink-0">Good</span>
) : best && best.score >= 50 ? (
    <span className="text-[9px] font-mono font-bold px-1 py-px rounded border border-zinc-600/40 bg-zinc-700/20 text-zinc-400 shrink-0">Low</span>
) : (
    <span className="text-[9px] font-mono text-zinc-600 shrink-0">—</span>
)}
```

Replace the action buttons (lines 185-226 area):

Ready section button:
```tsx
<button
    onClick={() => onMatch(s.invoiceId, best.orderId)}
    className="text-[10px] font-mono px-2 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition-colors shrink-0"
>
    Review match
</button>
```

Review section button:
```tsx
<button
    onClick={() => onMatch(s.invoiceId, best.orderId)}
    className="text-[10px] font-mono px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 transition-colors shrink-0"
>
    Compare
</button>
```

Section headers:
```tsx
{/* Replace "READY TO MATCH" */}
<div className="px-3 py-0.5 text-[9px] font-mono text-emerald-400/60 uppercase tracking-wider bg-emerald-500/5 border-b border-emerald-500/10">
    High confidence · {ready.length} · {fmtDollars(readyTotal)}
</div>
```

**Verification:** Build succeeds (`npm run build`), dashboard loads without JS errors, section headers show new labels, buttons say "Review match" / "Compare", percentage numbers replaced with High/Good/Low pills.

---

## Task 2: Hide alternative candidates behind expand

**Objective:** Replace the visible `also: 54% 124705 -43d | 54% 124691 -42d` pills with a collapsed `+2 alternatives` button that expands on click.

**Files:**
- Modify: `src/components/dashboard/InvoicePOMatcher.tsx`

**What to change:**

Add a `useState` for tracking which rows have expanded alternatives, then replace the alt candidate pills with a toggle.

Add state near top of component:
```tsx
const [expandedAlts, setExpandedAlts] = useState<Set<string>>(new Set());
```

Replace the alt candidates block (current lines ~243-274) in the non-compact render path:

```tsx
{/* Alternatives — collapsed by default */}
{!isAuto && s.candidates.length > 1 && (
    <div className="mt-0.5 ml-8">
        {expandedAlts.has(s.invoiceId) ? (
            <div className="flex flex-wrap gap-1 text-[8px] font-mono">
                {s.candidates.slice(1).map(c => {
                    const delta = daysBetween(s.invoiceDate, c.orderDate);
                    return (
                        <button
                            key={c.orderId}
                            onClick={() => onMatch(s.invoiceId, c.orderId)}
                            className={`px-1 py-px rounded border ${c.score >= 70 ? 'text-amber-400 border-amber-500/20 bg-amber-500/5' : 'text-zinc-500 border-zinc-700/30 bg-zinc-800/20'} hover:bg-zinc-700/30`}
                        >
                            {c.score}% {c.orderId}
                            {delta != null && <span className="opacity-60"> {delta > 0 ? `+${delta}d` : `${delta}d`}</span>}
                        </button>
                    );
                })}
                <button
                    onClick={() => setExpandedAlts(prev => { const n = new Set(prev); n.delete(s.invoiceId); return n; })}
                    className="text-zinc-500 hover:text-zinc-300 px-1"
                >
                    collapse
                </button>
            </div>
        ) : (
            <button
                onClick={() => setExpandedAlts(prev => new Set(prev).add(s.invoiceId))}
                className="text-[8px] font-mono text-zinc-500 hover:text-zinc-300"
            >
                +{s.candidates.length - 1} other possible match{s.candidates.length - 1 > 1 ? 'es' : ''}
            </button>
        )}
    </div>
)}
```

**Also update the Ready section** — it currently doesn't show alternatives (compact mode). Leave that as-is.

**Verification:** Build succeeds. Dashboard loads. Review section rows show "+N other possible matches" text instead of visible pills. Clicking it expands to show candidates with a "collapse" option. Clicking "collapse" hides them again.

---

## Task 3: Structured comparison for review rows

**Objective:** When a match needs review, show a side-by-side comparison table instead of just a confidence score and reasons line.

**Files:**
- Modify: `src/components/dashboard/InvoicePOMatcher.tsx`

**What to change:**

In the non-compact (review section) render path, replace the match reasons line and line items with a structured mini-table showing invoice vs PO side by side. Only show this for review rows (not ready/auto).

Replace the detail section (current lines ~306-315, the match reasons + line items blocks) in the non-compact path:

```tsx
{/* Structured comparison — only for review rows */}
{best && (
    <div className="mt-1 ml-8 grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-0.5 text-[8px] font-mono">
        {/* Header */}
        <span className="text-zinc-600"></span>
        <span className="text-zinc-500 font-semibold">Invoice</span>
        <span className="text-zinc-500 font-semibold">
            PO {best.orderId}
        </span>

        {/* Vendor */}
        <span className="text-zinc-600">Vendor</span>
        <span className="text-zinc-300">{s.vendorName}</span>
        <span className={s.vendorName === best.vendorName ? "text-emerald-400" : "text-amber-400"}>
            {best.vendorName}
        </span>

        {/* Amount */}
        <span className="text-zinc-600">Amount</span>
        <span className="text-zinc-300">{fmtDollars(s.invoiceTotal)}</span>
        <span className={Math.abs((Number(s.invoiceTotal) || 0) - (best.total || 0)) < 1 ? "text-emerald-400" : "text-amber-400"}>
            {fmtDollars(best.total)}
            {Math.abs((Number(s.invoiceTotal) || 0) - (best.total || 0)) >= 1 && (
                <span className="text-zinc-500 ml-0.5">
                    Δ{fmtDollars(Math.abs((Number(s.invoiceTotal) || 0) - (best.total || 0)))}
                </span>
            )}
        </span>

        {/* Date */}
        <span className="text-zinc-600">Date</span>
        <span className="text-zinc-300">{fmtShortDate(s.invoiceDate)}</span>
        {(() => {
            const delta = daysBetween(s.invoiceDate, best.orderDate);
            const withinWeek = delta !== null && Math.abs(delta) <= 7;
            return (
                <span className={withinWeek ? "text-emerald-400" : "text-amber-400"}>
                    {fmtShortDate(best.orderDate)}
                    {delta !== null && (
                        <span className="text-zinc-500 ml-0.5">
                            {delta > 0 ? `+${delta}d` : `${delta}d`}
                        </span>
                    )}
                </span>
            );
        })()}

        {/* Items (if line items exist) */}
        {hasLineItems && (() => {
            const poItems = receivedPOs.find(p => p.orderId === best.orderId)?.items ?? [];
            const matched = s.invoiceLineItems!.filter(li => li.sku && poItems.some(pi => pi.productId === li.sku));
            const unmatched = s.invoiceLineItems!.filter(li => li.sku && !poItems.some(pi => pi.productId === li.sku));
            const poOnly = poItems.filter(pi => !s.invoiceLineItems!.some(li => li.sku === pi.productId));
            return (
                <>
                    <span className="text-zinc-600">Items</span>
                    <span className="text-zinc-300">
                        {s.invoiceLineItems!.map(li => li.sku || li.description || "—").join(", ")}
                    </span>
                    <span className="text-zinc-400">
                        {matched.length > 0 && (
                            <span className="text-emerald-400">{matched.map(li => li.sku).join(", ")}</span>
                        )}
                        {unmatched.length > 0 && (
                            <span className="text-rose-400/70 ml-0.5">missing: {unmatched.map(li => li.sku).join(", ")}</span>
                        )}
                        {poOnly.length > 0 && (
                            <span className="text-zinc-600 ml-0.5">+{poOnly.length} more on PO</span>
                        )}
                    </span>
                </>
            );
        })()}

        {/* Verdict line */}
        <span className="text-zinc-600 pt-0.5">Verdict</span>
        <span className="text-zinc-400 pt-0.5 col-span-2">
            {best.reasons.slice(0, 3).join(" · ")}
        </span>
    </div>
)}
```

**IMPORTANT:** This comparison table replaces BOTH the current match reasons line AND the line items display AND the SKU overlap section. Remove those three blocks and replace with this single `{best && ( ... )}` block.

**Verification:** Build succeeds. Dashboard loads. Review section rows show a structured comparison table with Vendor, Amount, Date, Items (when available), and Verdict rows. Differences are color-coded (green = match, amber = differs). Ready section rows remain compact.

---

## Task 4: $0 invoice explanation

**Objective:** When an invoice has $0 total, show an explanation instead of "$0"

**Files:**
- Modify: `src/components/dashboard/InvoicePOMatcher.tsx`

**What to change:**

In the amount display, check for $0 and show an explanatory label instead:

Replace `{fmtDollars(s.invoiceTotal)}` in the amount column with:

```tsx
{s.invoiceTotal <= 0 ? (
    <span className="text-[9px] font-mono text-amber-500/60 shrink-0" title="OCR could not read invoice total">
        $?
    </span>
) : (
    <span className="text-[10px] font-mono text-zinc-400 ml-auto shrink-0">
        {fmtDollars(s.invoiceTotal)}
    </span>
)}
```

This applies in all three places where `fmtDollars(s.invoiceTotal)` appears.

**Verification:** Build succeeds. Dashboard loads. $0 invoices show "$?" in amber instead of "$0". Hover tooltip says "OCR could not read invoice total".

---

## Task 5: Build, restart, verify end-to-end

**Objective:** Build the full project, restart PM2, and verify the dashboard renders without errors

**Steps:**
1. Run `npm run build` from project root
2. If build fails, fix errors and rebuild
3. Run `pm2 restart aria-dashboard --update-env`
4. Wait for Finale data to load (~20s)
5. Verify in browser: Receivings panel shows three sections with new labels, comparison tables in review section, hidden alternatives, "$?" for $0 invoices

**Verification command:**
```bash
cd /c/Users/BuildASoil/Documents/Projects/aria && npm run build 2>&1 | tail -5
pm2 restart aria-dashboard --update-env
```
