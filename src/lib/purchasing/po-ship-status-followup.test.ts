/**
 * @file    po-ship-status-followup.test.ts
 * @purpose Unit tests for the ship-status follow-up stage (WS6.1, ported from
 *          aria/3way-match-gate-fix). The candidate filter, draft window,
 *          invoice gate and dashboard-flag idempotence are pure and tested
 *          without DB/Gmail; the scan is tested against a minimal PostgREST
 *          stand-in so the invoice leg (zero-total = not invoiced) is proven.
 */

import { describe, expect, it, vi } from "vitest";

import {
    CANDIDATE_LOOKBACK_DAYS,
    MAX_DAYS_SINCE_ACK,
    MIN_DAYS_SINCE_ACK,
    NO_TRACKING_AFTER_ACK_DAYS,
    SHIP_STATUS_SUMMARY_PREFIX,
    alreadyFlaggedByShipStatus,
    daysSinceAck,
    flagPoOnDashboard,
    hasRealInvoice,
    isDropshipVendor,
    isFinalePoNumber,
    isNoTrackingAfterAckCandidate,
    isShipStatusCandidate,
    scanShipStatusCandidates,
    shouldDraftShipStatus,
    silentPoSummary,
} from "./po-ship-status-followup";

const NOW = new Date("2026-10-29T15:00:00Z").getTime();
const DAY = 86_400_000;

function basePo(overrides: Record<string, unknown> = {}) {
    return {
        vendor_name: "Rapid Packaging",
        vendor_acknowledged_at: new Date(NOW - 10 * DAY).toISOString(), // acked 10d ago
        tracking_numbers: [],
        tracking_requested_at: null,
        vendor_noncomm_at: null,
        receive_date: null,
        status: "Committed",
        ...overrides,
    };
}

/** PO 125283 as it actually sits in purchase_orders (2026-10-29). */
function po125283(overrides: Record<string, unknown> = {}) {
    return {
        po_number: "125283",
        vendor_name: "Rapid Packaging",
        vendor_party_id: "10925",
        vendor_acknowledged_at: "2026-09-10T11:21:07-06:00",
        tracking_numbers: [],
        tracking_requested_at: null,
        vendor_noncomm_at: null,
        lifecycle_stage: null,
        receive_date: null,
        status: "Committed",
        total_amount: 5328,
        total: 5328,
        line_items: [{ productId: "RAP101", quantity: "900", unitPrice: 5.92, remainingQty: 900 }],
        issue_date: "2026-09-09T00:00:00-06:00",
        required_date: "2026-09-09T00:00:00-06:00",
        needs_human_review: false,
        last_movement_summary: null,
        ...overrides,
    };
}

// ── A tiny thenable PostgREST stand-in (filters applied, errors pass through) ──

type TableConfig = { rows?: any[]; error?: any };

function makeDb(config: Record<string, TableConfig>) {
    const db = {
        from(table: string) {
            const cfg = config[table] ?? { rows: [] };
            let rows = [...(cfg.rows ?? [])];
            let takeAll = true;
            let limitN: number | null = null;
            let offsetN = 0;
            const slice = () => (takeAll ? rows : rows.slice(offsetN, offsetN + (limitN ?? rows.length)));
            const builder: any = {
                select: () => builder,
                gte: (col: string, val: any) => {
                    rows = rows.filter((r) => String(r?.[col] ?? "") >= String(val));
                    return builder;
                },
                lte: (col: string, val: any) => {
                    rows = rows.filter((r) => String(r?.[col] ?? "") <= String(val));
                    return builder;
                },
                is: (col: string, val: any) => {
                    rows = rows.filter((r) => (r?.[col] ?? null) === val);
                    return builder;
                },
                or: () => builder,
                order: () => builder,
                limit: (n: number) => {
                    limitN = n;
                    takeAll = false;
                    return builder;
                },
                offset: (n: number) => {
                    offsetN = n;
                    takeAll = false;
                    return builder;
                },
                in: (col: string, vals: any[]) => {
                    rows = rows.filter((r) => vals.includes(r?.[col]));
                    return builder;
                },
                eq: (col: string, val: any) => {
                    rows = rows.filter((r) => r?.[col] === val);
                    return builder;
                },
                maybeSingle: async () => ({ data: slice()[0] ?? null, error: cfg.error ?? null }),
                update: () => builder,
                then: (resolve: any) => resolve({ data: slice(), error: cfg.error ?? null }),
            };
            return builder;
        },
    };
    return db as any;
}

describe("isFinalePoNumber", () => {
    it("accepts Finale 6-digit POs, with or without the PO- prefix", () => {
        expect(isFinalePoNumber("125283")).toBe(true);
        expect(isFinalePoNumber("PO-124675")).toBe(true);
        expect(isFinalePoNumber(" po-125283 ")).toBe(true);
    });

    it("rejects marketplace / web order ids and blanks", () => {
        expect(isFinalePoNumber("23507197")).toBe(false);
        expect(isFinalePoNumber("23459847-S-DropshipPO")).toBe(false);
        expect(isFinalePoNumber("")).toBe(false);
        expect(isFinalePoNumber(null)).toBe(false);
    });
});

describe("isShipStatusCandidate", () => {
    it("qualifies an acked PO with no tracking inside the window", () => {
        expect(isShipStatusCandidate(basePo(), NOW)).toEqual({ ok: true });
    });

    // ── The PO this stage exists for ──────────────────────────────────────
    // Acked 2026-09-10, 900 x RAP101, $5,328, no tracking, no follow-up ever.
    it("qualifies PO 125283 (acked 48d, still open, no tracking, no receipt)", () => {
        expect(isShipStatusCandidate(po125283(), NOW)).toEqual({ ok: true });
    });

    it("has NO upper age bound — aged silence is the failure being caught", () => {
        const ackedLongAgo = new Date(NOW - 300 * DAY).toISOString();
        expect(isShipStatusCandidate(basePo({ vendor_acknowledged_at: ackedLongAgo }), NOW)).toEqual(
            { ok: true },
        );
    });

    it("rejects POs with no vendor acknowledgment", () => {
        const v = isShipStatusCandidate(basePo({ vendor_acknowledged_at: null }), NOW);
        expect(v.ok).toBe(false);
        expect(v.reason).toBe("no_ack");
    });

    it("rejects POs acked too recently", () => {
        const fresh = new Date(NOW - (MIN_DAYS_SINCE_ACK - 1) * DAY).toISOString();
        expect(isShipStatusCandidate(basePo({ vendor_acknowledged_at: fresh }), NOW).reason).toBe(
            "too_early",
        );
    });

    it("rejects POs that already have tracking", () => {
        expect(
            isShipStatusCandidate(basePo({ tracking_numbers: ["1Z999AA10123456784"] }), NOW).reason,
        ).toBe("has_tracking");
    });

    it("rejects POs where tracking was already requested after the ack", () => {
        const v = isShipStatusCandidate(
            basePo({
                vendor_acknowledged_at: new Date(NOW - 10 * DAY).toISOString(),
                tracking_requested_at: new Date(NOW - 9 * DAY).toISOString(),
            }),
            NOW,
        );
        expect(v.reason).toBe("already_requested");
    });

    // po-followup-watcher's L1 48h receipt check also stamps
    // tracking_requested_at, and that draft can predate the vendor's ack.
    // A pre-ack stamp is NOT a tracking request.
    it("allows a PO whose tracking_requested_at stamp predates the ack", () => {
        const v = isShipStatusCandidate(
            basePo({
                vendor_acknowledged_at: new Date(NOW - 10 * DAY).toISOString(),
                tracking_requested_at: new Date(NOW - 12 * DAY).toISOString(),
            }),
            NOW,
        );
        expect(v).toEqual({ ok: true });
    });

    it("rejects a stamp with no ack to compare against (conservative)", () => {
        const v = isShipStatusCandidate(
            basePo({
                vendor_acknowledged_at: null,
                tracking_requested_at: new Date(NOW - DAY).toISOString(),
            }),
            NOW,
        );
        expect(v.reason).toBe("already_requested");
    });

    it("rejects an unparseable tracking_requested_at (defensive)", () => {
        expect(isShipStatusCandidate(basePo({ tracking_requested_at: "not-a-date" }), NOW).reason).toBe(
            "already_requested",
        );
    });

    it("rejects POs marked vendor noncomm", () => {
        expect(
            isShipStatusCandidate(basePo({ vendor_noncomm_at: new Date(NOW - 2 * DAY).toISOString() }), NOW)
                .reason,
        ).toBe("noncomm");
    });

    it("rejects received POs by status", () => {
        expect(isShipStatusCandidate(basePo({ status: "received" }), NOW).reason).toBe("received");
    });

    it("rejects terminal statuses other than received", () => {
        expect(isShipStatusCandidate(basePo({ status: "Closed" }), NOW).reason).toBe(
            "terminal_status",
        );
        expect(isShipStatusCandidate(basePo({ status: "Cancelled" }), NOW).reason).toBe(
            "terminal_status",
        );
        expect(isShipStatusCandidate(basePo({ status: "Completed" }), NOW).reason).toBe(
            "terminal_status",
        );
    });

    it("rejects received POs by past receive_date", () => {
        expect(
            isShipStatusCandidate(basePo({ receive_date: new Date(NOW - DAY).toISOString() }), NOW)
                .reason,
        ).toBe("received");
    });

    it("rejects a PO with receipt scheduled within 3 days", () => {
        expect(
            isShipStatusCandidate(basePo({ receive_date: new Date(NOW + 2 * DAY).toISOString() }), NOW)
                .reason,
        ).toBe("receipt_scheduled_soon");
    });

    it("allows a future receive_date outside the 3-day window", () => {
        expect(
            isShipStatusCandidate(basePo({ receive_date: new Date(NOW + 5 * DAY).toISOString() }), NOW)
                .ok,
        ).toBe(true);
    });

    // ── Read-then-act race guard: the verdict must flip on the fresh clock ──
    it("flips to rejected when receive_date passes mid-scan", () => {
        const po = basePo({ receive_date: new Date(NOW + 5 * DAY).toISOString() });
        expect(isShipStatusCandidate(po, NOW).ok).toBe(true);
        expect(isShipStatusCandidate(po, NOW + 6 * DAY)).toEqual({ ok: false, reason: "received" });
    });

    it("flips to rejected when status flips to received mid-scan", () => {
        const po = basePo();
        expect(isShipStatusCandidate(po, NOW).ok).toBe(true);
        expect(isShipStatusCandidate({ ...po, status: "received" }, NOW + DAY)).toEqual({
            ok: false,
            reason: "received",
        });
    });

    it("flips to rejected when a receipt moves inside 3 days mid-scan", () => {
        const po = basePo({ receive_date: new Date(NOW + 6 * DAY).toISOString() });
        expect(isShipStatusCandidate(po, NOW).ok).toBe(true);
        expect(isShipStatusCandidate(po, NOW + 4 * DAY)).toEqual({
            ok: false,
            reason: "receipt_scheduled_soon",
        });
    });
});

describe("isNoTrackingAfterAckCandidate (5d early trigger)", () => {
    it("threshold sits between a normal ship lag and the draft window", () => {
        expect(NO_TRACKING_AFTER_ACK_DAYS).toBe(5);
        expect(NO_TRACKING_AFTER_ACK_DAYS).toBeLessThan(MIN_DAYS_SINCE_ACK);
    });

    it("qualifies a PO acked 5d ago with no tracking and not received", () => {
        expect(
            isNoTrackingAfterAckCandidate(
                basePo({ vendor_acknowledged_at: new Date(NOW - NO_TRACKING_AFTER_ACK_DAYS * DAY).toISOString() }),
                NOW,
            ),
        ).toEqual({ ok: true });
    });

    it("still qualifies through the 6d day of the early band", () => {
        expect(
            isNoTrackingAfterAckCandidate(
                basePo({ vendor_acknowledged_at: new Date(NOW - 6 * DAY).toISOString() }),
                NOW,
            ),
        ).toEqual({ ok: true });
    });

    it("keeps qualifying an aged silent PO (PO 125283 shape)", () => {
        expect(isNoTrackingAfterAckCandidate(po125283(), NOW)).toEqual({ ok: true });
    });

    it("rejects an ack younger than the threshold", () => {
        const fresh = new Date(NOW - (NO_TRACKING_AFTER_ACK_DAYS - 1) * DAY).toISOString();
        expect(
            isNoTrackingAfterAckCandidate(basePo({ vendor_acknowledged_at: fresh }), NOW).reason,
        ).toBe("too_early");
    });

    it("rejects no ack / unparseable ack", () => {
        expect(
            isNoTrackingAfterAckCandidate(basePo({ vendor_acknowledged_at: null }), NOW).reason,
        ).toBe("no_ack");
        expect(
            isNoTrackingAfterAckCandidate(basePo({ vendor_acknowledged_at: "not-a-date" }), NOW).reason,
        ).toBe("no_ack");
    });

    it("rejects a PO that already has tracking", () => {
        expect(
            isNoTrackingAfterAckCandidate(
                basePo({ tracking_numbers: ["1Z999AA10123456784"] }),
                NOW,
            ).reason,
        ).toBe("has_tracking");
    });

    it("rejects received and terminal POs", () => {
        expect(isNoTrackingAfterAckCandidate(basePo({ status: "Received" }), NOW).reason).toBe(
            "received",
        );
        expect(isNoTrackingAfterAckCandidate(basePo({ status: "Closed" }), NOW).reason).toBe(
            "terminal_status",
        );
        expect(
            isNoTrackingAfterAckCandidate(
                basePo({ receive_date: new Date(NOW - DAY).toISOString() }),
                NOW,
            ).reason,
        ).toBe("received");
    });

    it("rejects a receipt scheduled inside the 3-day window", () => {
        expect(
            isNoTrackingAfterAckCandidate(
                basePo({ receive_date: new Date(NOW + 2 * DAY).toISOString() }),
                NOW,
            ).reason,
        ).toBe("receipt_scheduled_soon");
    });

    // ── Exclusions: these vendors never hand us tracking ──────────────────
    it("excludes dropship vendors", () => {
        expect(
            isNoTrackingAfterAckCandidate(basePo({ vendor_name: "Autopot USA" }), NOW).reason,
        ).toBe("dropship");
        expect(
            isNoTrackingAfterAckCandidate(
                basePo({ vendor_name: "Horticulture Lighting Group" }),
                NOW,
            ).reason,
        ).toBe("dropship");
    });

    it("excludes paid-in-advance vendors", () => {
        expect(
            isNoTrackingAfterAckCandidate(basePo({ vendor_name: "Sustainable Village" }), NOW).reason,
        ).toBe("paid_in_advance");
        expect(
            isNoTrackingAfterAckCandidate(basePo({ vendor_name: "Cen-Tec Systems" }), NOW).reason,
        ).toBe("paid_in_advance");
        expect(
            isNoTrackingAfterAckCandidate(basePo({ vendor_name: "Colorful Packaging" }), NOW).reason,
        ).toBe("paid_in_advance");
    });

    it("excludes vendor-noncomm rows and prior tracking requests", () => {
        expect(
            isNoTrackingAfterAckCandidate(
                basePo({ vendor_noncomm_at: new Date(NOW - 2 * DAY).toISOString() }),
                NOW,
            ).reason,
        ).toBe("noncomm");
        expect(
            isNoTrackingAfterAckCandidate(
                basePo({ tracking_requested_at: new Date(NOW - 4 * DAY).toISOString() }),
                NOW,
            ).reason,
        ).toBe("already_requested");
    });

    it("does not treat a pre-ack receipt-check stamp as a tracking request", () => {
        expect(
            isNoTrackingAfterAckCandidate(
                basePo({
                    vendor_acknowledged_at: new Date(NOW - 6 * DAY).toISOString(),
                    tracking_requested_at: new Date(NOW - 8 * DAY).toISOString(),
                }),
                NOW,
            ),
        ).toEqual({ ok: true });
    });
});

describe("isDropshipVendor", () => {
    it("matches the shared dropship pattern", () => {
        expect(isDropshipVendor("Autopot USA")).toBe(true);
        expect(isDropshipVendor("Printful")).toBe(true);
        expect(isDropshipVendor("AC Infinity")).toBe(true);
        expect(isDropshipVendor("Rapid Packaging")).toBe(false);
        expect(isDropshipVendor(null)).toBe(false);
    });
});

describe("shouldDraftShipStatus (email window)", () => {
    it("drafts inside the 7-30d window", () => {
        expect(
            shouldDraftShipStatus(
                { vendor_acknowledged_at: new Date(NOW - 10 * DAY).toISOString() },
                NOW,
            ),
        ).toBe(true);
    });

    it("does not draft before 7 days", () => {
        expect(
            shouldDraftShipStatus(
                { vendor_acknowledged_at: new Date(NOW - 3 * DAY).toISOString() },
                NOW,
            ),
        ).toBe(false);
    });

    // 125283 is a candidate at 49d but is NOT drafted — a "has it shipped?"
    // email on a 7-week-old thread is noise; the row is flagged for a human.
    it("does not draft past MAX_DAYS_SINCE_ACK even though the PO is a candidate", () => {
        const row = po125283();
        expect(isShipStatusCandidate(row, NOW).ok).toBe(true);
        expect(shouldDraftShipStatus(row, NOW)).toBe(false);
        expect(
            shouldDraftShipStatus(
                { vendor_acknowledged_at: new Date(NOW - (MAX_DAYS_SINCE_ACK - 1) * DAY).toISOString() },
                NOW,
            ),
        ).toBe(true);
    });
});

describe("hasRealInvoice (WS2.4 rule applied to this stage)", () => {
    it("treats an empty invoice set as unbilled", () => {
        expect(hasRealInvoice([])).toBe(false);
        expect(hasRealInvoice(null)).toBe(false);
    });

    // PO 125283 carries invoice 5271576 at $0.00 — a phantom identity, not a bill.
    it("treats a zero-total invoice as NOT billed", () => {
        expect(hasRealInvoice([{ total: 0 }])).toBe(false);
        expect(hasRealInvoice([{ total: "0.00" }])).toBe(false);
    });

    it("treats a positive-total invoice as billed", () => {
        expect(hasRealInvoice([{ total: 0 }, { total: 671.25 }])).toBe(true);
        expect(hasRealInvoice([{ total: "2995.75" }])).toBe(true);
    });
});

describe("dashboard-row output", () => {
    it("names the PO state in last_movement_summary", () => {
        const summary = silentPoSummary(49, NOW);
        expect(summary).toBe(
            "Ship-status follow-up 2026-10-29: vendor acked 49d ago, no tracking, no invoice — chase ship status or cancel.",
        );
        expect(summary.startsWith(SHIP_STATUS_SUMMARY_PREFIX)).toBe(true);
    });

    it("recognises a row this stage already stamped", () => {
        expect(alreadyFlaggedByShipStatus({ last_movement_summary: silentPoSummary(49, NOW) })).toBe(
            true,
        );
        expect(
            alreadyFlaggedByShipStatus({ last_movement_summary: "[in_transit] Expected Jun 12" }),
        ).toBe(false);
        expect(alreadyFlaggedByShipStatus(null)).toBe(false);
    });

    it("does not rewrite a row an earlier run already flagged", async () => {
        const update = vi.fn();
        const db = makeDb({
            purchase_orders: {
                rows: [
                    {
                        po_number: "125283",
                        needs_human_review: true,
                        last_movement_summary: silentPoSummary(49, NOW),
                    },
                ],
            },
        });
        // hook update() to observe writes
        const original = db.from;
        db.from = (table: string) => {
            const builder = original(table);
            if (table === "purchase_orders") {
                const origUpdate = builder.update;
                builder.update = (payload: any) => {
                    update(payload);
                    return origUpdate(payload);
                };
            }
            return builder;
        };
        await flagPoOnDashboard(db, "125283", { daysAcked: 49, nowMs: NOW });
        expect(update).not.toHaveBeenCalled();
    });

    it("refreshes a summary whose ack age has moved (a frozen day count is a stale signal)", async () => {
        const db = makeDb({
            purchase_orders: {
                rows: [
                    {
                        po_number: "125283",
                        needs_human_review: true,
                        last_movement_summary: silentPoSummary(5, NOW),
                    },
                ],
            },
        });
        const update = vi.fn();
        const original = db.from;
        db.from = (table: string) => {
            const builder = original(table);
            if (table === "purchase_orders") {
                const origUpdate = builder.update;
                builder.update = (payload: Record<string, unknown>) => {
                    update(payload);
                    return origUpdate(payload);
                };
            }
            return builder;
        };
        await flagPoOnDashboard(db, "125283", { daysAcked: 12, nowMs: NOW });
        expect(update).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0][0].last_movement_summary).toContain("acked 12d ago");
    });

    it("writes needs_human_review + summary on a fresh row", async () => {
        const db = makeDb({
            purchase_orders: {
                rows: [{ po_number: "125283", needs_human_review: false, last_movement_summary: null }],
            },
        });
        const update = vi.fn();
        const original = db.from;
        db.from = (table: string) => {
            const builder = original(table);
            if (table === "purchase_orders") {
                const origUpdate = builder.update;
                builder.update = (payload: any) => {
                    update(payload);
                    return origUpdate(payload);
                };
            }
            return builder;
        };
        await flagPoOnDashboard(db, "125283", { daysAcked: 49, nowMs: NOW });
        expect(update).toHaveBeenCalledTimes(1);
        expect(update.mock.calls[0][0].needs_human_review).toBe(true);
        expect(update.mock.calls[0][0].last_movement_summary).toContain("acked 49d ago");
    });
});

describe("scanShipStatusCandidates", () => {
    it("returns PO 125283 — acked 48d, zero-total invoice, no tracking", async () => {
        const db = makeDb({
            purchase_orders: { rows: [po125283()] },
            vendor_invoices: { rows: [{ po_number: "125283", total: 0 }] },
        });
        const found = await scanShipStatusCandidates(db, { nowMs: NOW });
        expect(found.map((c) => c.po.po_number)).toEqual(["125283"]);
        expect(found[0].daysAcked).toBe(48);
        expect(found[0].draftWorthy).toBe(false);
    });

    it("drops a PO once a real (positive-total) invoice lands", async () => {
        const db = makeDb({
            purchase_orders: { rows: [po125283()] },
            vendor_invoices: { rows: [{ po_number: "125283", total: 5328 }] },
        });
        expect(await scanShipStatusCandidates(db, { nowMs: NOW })).toEqual([]);
    });

    it("never flags non-Finale order ids", async () => {
        const db = makeDb({
            purchase_orders: { rows: [po125283({ po_number: "23507197" })] },
            vendor_invoices: { rows: [] },
        });
        expect(await scanShipStatusCandidates(db, { nowMs: NOW })).toEqual([]);
    });

    it("skips received and not-yet-7d POs", async () => {
        const db = makeDb({
            purchase_orders: {
                rows: [
                    po125283({ po_number: "125400", status: "Received" }),
                    po125283({
                        po_number: "125401",
                        vendor_acknowledged_at: new Date(NOW - 2 * DAY).toISOString(),
                    }),
                ],
            },
            vendor_invoices: { rows: [] },
        });
        expect(await scanShipStatusCandidates(db, { nowMs: NOW })).toEqual([]);
    });

    it("returns [] on a read error instead of throwing", async () => {
        const db = makeDb({
            purchase_orders: { rows: [], error: { message: "42703 column does not exist" } },
        });
        expect(await scanShipStatusCandidates(db, { nowMs: NOW })).toEqual([]);
    });

    it("surfaces a 6d acked no-tracking PO on the early trigger (flag, no draft)", async () => {
        const db = makeDb({
            purchase_orders: {
                rows: [
                    po125283({
                        vendor_acknowledged_at: new Date(NOW - 6 * DAY).toISOString(),
                    }),
                ],
            },
            vendor_invoices: { rows: [] },
        });
        const found = await scanShipStatusCandidates(db, { nowMs: NOW });
        expect(found).toHaveLength(1);
        expect(found[0].trigger).toBe("no_tracking_after_ack");
        expect(found[0].draftWorthy).toBe(false);
    });

    it("tags a 10d acked PO on the original ship-status trigger (draft window open)", async () => {
        const db = makeDb({
            purchase_orders: {
                rows: [
                    po125283({
                        vendor_acknowledged_at: new Date(NOW - 10 * DAY).toISOString(),
                    }),
                ],
            },
            vendor_invoices: { rows: [] },
        });
        const found = await scanShipStatusCandidates(db, { nowMs: NOW });
        expect(found).toHaveLength(1);
        expect(found[0].trigger).toBe("ship_status");
        expect(found[0].draftWorthy).toBe(true);
    });

    it("never surfaces dropship or paid-in-advance POs on the early trigger", async () => {
        const db = makeDb({
            purchase_orders: {
                rows: [
                    po125283({
                        po_number: "125500",
                        vendor_name: "Autopot USA",
                        vendor_acknowledged_at: new Date(NOW - 6 * DAY).toISOString(),
                    }),
                    po125283({
                        po_number: "125501",
                        vendor_name: "Sustainable Village",
                        vendor_acknowledged_at: new Date(NOW - 6 * DAY).toISOString(),
                    }),
                ],
            },
            vendor_invoices: { rows: [] },
        });
        expect(await scanShipStatusCandidates(db, { nowMs: NOW })).toEqual([]);
    });

    it("exposes the lookback window as a constant", () => {
        expect(CANDIDATE_LOOKBACK_DAYS).toBeGreaterThan(MIN_DAYS_SINCE_ACK);
    });

    /**
     * Regression (2026-10-29): the first live dry-run returned 0 candidates
     * while 125283 had to qualify. `purchase_orders` carries a 277-row cohort
     * all stamped with one backfilled ack date, and the scan read the window
     * with a single oldest-first `.limit(200)` — so it never reached 125283 and
     * reported "no candidates" with a clean `error: null`. The scan now pages.
     */
    it("pages a tied cohort instead of capping the read", async () => {
        const tiedAck = "2026-07-22T14:00:29Z";
        const cohort = Array.from({ length: 620 }, (_, i) =>
            po125283({
                po_number: String(23000000 + i), // 8-digit marketplace ids: read, rejected
                vendor_acknowledged_at: tiedAck,
            }),
        );
        const db = makeDb({
            purchase_orders: { rows: [...cohort, po125283()] },
            vendor_invoices: { rows: [] },
        });

        const found = await scanShipStatusCandidates(db, { nowMs: NOW });
        expect(found.map((c) => c.po.po_number)).toEqual(["125283"]);

        // The examined-row cap still binds — prove the cohort really does hide it.
        expect(await scanShipStatusCandidates(db, { nowMs: NOW, limit: 200 })).toEqual([]);
    });

    it("never returns the same PO twice when a tie crosses a page boundary", async () => {
        const rows = Array.from({ length: 501 }, () => po125283());
        const db = makeDb({ purchase_orders: { rows }, vendor_invoices: { rows: [] } });
        expect(await scanShipStatusCandidates(db, { nowMs: NOW })).toHaveLength(1);
    });
});

describe("daysSinceAck", () => {
    it("counts whole days and tolerates junk", () => {
        expect(daysSinceAck(new Date(NOW - 49 * DAY).toISOString(), NOW)).toBe(49);
        expect(daysSinceAck(null, NOW)).toBeNull();
        expect(daysSinceAck("nope", NOW)).toBeNull();
    });
});
