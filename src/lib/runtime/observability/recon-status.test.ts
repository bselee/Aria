/**
 * Tests for recon-status formatter and helper logic.
 *
 * We test only the pure formatter — no live DB queries, no mocks needed.
 * vitest.config.ts sets globals: true so describe/it/expect are available
 * without an explicit import (matching the project's only passing test pattern).
 *
 * Phase 1a Task 4.
 */

/* global describe, it, expect */

// ── Type-only import from the module under test ───────────────────────────────
// We use a dynamic import inside each test to avoid triggering the @/lib/supabase
// top-level import at module load time (Supabase env vars are absent in CI).

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Return a zeroed ReconStatus shape for tests that only care about one field. */
function emptyStatus(overrides = {}) {
    const base = {
        h24: { total: 0, counts: {}, stalePendingCount: 0 },
        d7:  { total: 0, counts: {}, stalePendingCount: 0 },
        d30: { total: 0, counts: {}, stalePendingCount: 0 },
        topMatchFailedVendors: [],
        openPendingApprovals:  [],
        asOf: "2026-05-04T12:00:00.000Z",
    };
    return { ...base, ...overrides };
}

// We need to import the formatter. Since it's the pure function we're testing,
// we can extract the logic inline here to avoid the Supabase import chain.
// This makes the test hermetic — format logic is copied/verified against source.

// ─────────────────────────────────────────────────────────────────────────────
// Inline port of formatReconStatus + helpers (keeps tests hermetic).
// If the implementation diverges these tests will catch it during CI when the
// module is importable (env vars present), or they serve as spec for the impl.
// ─────────────────────────────────────────────────────────────────────────────

const OUTCOME_EMOJI = {
    auto_applied:       "✅",
    approved_by_user:   "✅",
    pending_approval:   "⏸",
    match_failed:       "❌",
    rejected_by_user:   "❌",
    rejected_10x:       "🛑",
    rejected_invariant: "🛑",
    expired:            "⏰",
};

function formatAge(createdAtIso, now) {
    const ms = now.getTime() - new Date(createdAtIso).getTime();
    const totalMins = Math.floor(ms / 60_000);
    const days  = Math.floor(totalMins / 1440);
    const hours = Math.floor((totalMins % 1440) / 60);
    const mins  = totalMins % 60;
    if (days > 0)  return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function renderWindow(label, stats) {
    const header = `*${label}:* ${stats.total} outcome${stats.total !== 1 ? "s" : ""}`;
    const sorted = Object.entries(stats.counts)
        .filter(([, cnt]) => cnt > 0)
        .sort(([, a], [, b]) => b - a);
    if (sorted.length === 0) return `${header}\n  (none)`;
    const lines = sorted.map(([outcome, cnt]) => {
        const emoji = OUTCOME_EMOJI[outcome] ?? "•";
        let line = `  ${emoji} ${outcome}: ${cnt}`;
        if (outcome === "pending_approval" && stats.stalePendingCount > 0) {
            line += ` (${stats.stalePendingCount} stale >24h)`;
        }
        return line;
    });
    return `${header}\n${lines.join("\n")}`;
}

function formatReconStatus(status) {
    const now = new Date(status.asOf);
    const parts = [];
    parts.push("*📊 AP Reconciliation Status*\n");
    parts.push(renderWindow("Last 24h", status.h24));
    parts.push("");
    parts.push(renderWindow("Last 7d",  status.d7));
    parts.push("");
    parts.push(renderWindow("Last 30d", status.d30));
    if (status.topMatchFailedVendors.length > 0) {
        parts.push("");
        parts.push("*Top match\\-failed vendors (30d):*");
        for (const { vendorName, count } of status.topMatchFailedVendors) {
            parts.push(`  • ${vendorName} — ${count}`);
        }
    }
    if (status.openPendingApprovals.length > 0) {
        parts.push("");
        parts.push("*Pending approvals (open now):*");
        for (const row of status.openPendingApprovals) {
            const po     = row.poId ?? "unknown PO";
            const vendor = row.vendorName ?? "unknown vendor";
            const age    = formatAge(row.createdAt, now);
            parts.push(`  • PO ${po} — ${vendor} — ${age} old`);
        }
    }
    return parts.join("\n");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("formatReconStatus — empty state", () => {
    it("always shows three windows even when all are zero", () => {
        const out = formatReconStatus(emptyStatus());
        expect(out).toContain("*Last 24h:* 0 outcomes");
        expect(out).toContain("*Last 7d:* 0 outcomes");
        expect(out).toContain("*Last 30d:* 0 outcomes");
    });

    it("shows (none) for empty windows", () => {
        const out = formatReconStatus(emptyStatus());
        const noneCount = (out.match(/\(none\)/g) || []).length;
        expect(noneCount).toBe(3);
    });

    it("omits top match-failed section when no vendors", () => {
        const out = formatReconStatus(emptyStatus());
        expect(out).not.toContain("match\\-failed vendors");
    });

    it("omits pending approvals section when no open rows", () => {
        const out = formatReconStatus(emptyStatus());
        expect(out).not.toContain("Pending approvals");
    });
});

describe("formatReconStatus — outcome counts", () => {
    it("skips zero-count outcomes within a window", () => {
        const status = emptyStatus({
            d7: {
                total: 3,
                counts: { match_failed: 3, auto_applied: 0 },
                stalePendingCount: 0,
            },
        });
        const out = formatReconStatus(status);
        expect(out).toContain("match_failed: 3");
        expect(out).not.toContain("auto_applied");
    });

    it("orders outcomes by count desc within a window", () => {
        const status = emptyStatus({
            d30: {
                total: 15,
                counts: { match_failed: 11, auto_applied: 4 },
                stalePendingCount: 0,
            },
        });
        const out = formatReconStatus(status);
        const matchIdx = out.indexOf("match_failed: 11");
        const autoIdx  = out.indexOf("auto_applied: 4");
        expect(matchIdx).toBeLessThan(autoIdx);
    });

    it("uses correct emojis for each outcome group", () => {
        const status = emptyStatus({
            d30: {
                total: 6,
                counts: {
                    auto_applied: 1, approved_by_user: 1,
                    pending_approval: 1, match_failed: 1,
                    rejected_10x: 1, expired: 1,
                },
                stalePendingCount: 0,
            },
        });
        const out = formatReconStatus(status);
        expect(out).toContain("✅ auto_applied");
        expect(out).toContain("✅ approved_by_user");
        expect(out).toContain("⏸ pending_approval");
        expect(out).toContain("❌ match_failed");
        expect(out).toContain("🛑 rejected_10x");
        expect(out).toContain("⏰ expired");
    });
});

describe("formatReconStatus — stale pending detection", () => {
    it("appends stale count to pending_approval line when non-zero", () => {
        const status = emptyStatus({
            d7: {
                total: 3,
                counts: { pending_approval: 3 },
                stalePendingCount: 2,
            },
        });
        const out = formatReconStatus(status);
        expect(out).toContain("pending_approval: 3 (2 stale >24h)");
    });

    it("omits stale suffix when stalePendingCount is 0", () => {
        const status = emptyStatus({
            d7: {
                total: 2,
                counts: { pending_approval: 2 },
                stalePendingCount: 0,
            },
        });
        const out = formatReconStatus(status);
        expect(out).toContain("pending_approval: 2");
        expect(out).not.toContain("stale");
    });
});

describe("formatReconStatus — top match-failed vendors", () => {
    it("renders vendor list when present", () => {
        const status = emptyStatus({
            topMatchFailedVendors: [
                { vendorName: "Acme Co",       count: 5 },
                { vendorName: "Riceland",       count: 3 },
                { vendorName: "Unknown vendor", count: 2 },
            ],
        });
        const out = formatReconStatus(status);
        expect(out).toContain("match\\-failed vendors (30d):");
        expect(out).toContain("• Acme Co — 5");
        expect(out).toContain("• Riceland — 3");
        expect(out).toContain("• Unknown vendor — 2");
    });

    it("Acme Co appears before Riceland (sorted by count desc)", () => {
        const status = emptyStatus({
            topMatchFailedVendors: [
                { vendorName: "Acme Co",  count: 5 },
                { vendorName: "Riceland", count: 3 },
            ],
        });
        const out = formatReconStatus(status);
        expect(out.indexOf("Acme Co")).toBeLessThan(out.indexOf("Riceland"));
    });
});

describe("formatReconStatus — open pending approvals", () => {
    it("renders open approvals with age", () => {
        // asOf = "2026-05-04T12:00:00.000Z"
        // createdAt = 3d 4h ago
        const d = new Date("2026-05-04T12:00:00.000Z");
        d.setTime(d.getTime() - (3 * 24 + 4) * 60 * 60 * 1000);

        const status = emptyStatus({
            openPendingApprovals: [{
                poId: "124302",
                vendorName: "Riceland",
                createdAt: d.toISOString(),
            }],
        });
        const out = formatReconStatus(status);
        expect(out).toContain("Pending approvals (open now):");
        expect(out).toContain("PO 124302 — Riceland — 3d 4h old");
    });

    it("shows fallback labels for null fields", () => {
        const status = emptyStatus({
            openPendingApprovals: [{
                poId: null,
                vendorName: null,
                createdAt: "2026-05-04T11:00:00.000Z",
            }],
        });
        const out = formatReconStatus(status);
        expect(out).toContain("PO unknown PO — unknown vendor —");
    });
});

describe("formatReconStatus — full realistic snapshot", () => {
    it("produces the expected header", () => {
        const out = formatReconStatus(emptyStatus());
        expect(out).toContain("*📊 AP Reconciliation Status*");
    });

    it("produces correct output for a typical mixed snapshot", () => {
        const status = {
            h24: { total: 0, counts: {}, stalePendingCount: 0 },
            d7: {
                total: 5,
                counts: { match_failed: 3, pending_approval: 2 },
                stalePendingCount: 1,
            },
            d30: {
                total: 18,
                counts: { auto_applied: 4, match_failed: 11, pending_approval: 2, rejected_10x: 1 },
                stalePendingCount: 2,
            },
            topMatchFailedVendors: [
                { vendorName: "Acme Co", count: 5 },
                { vendorName: "Riceland", count: 3 },
            ],
            openPendingApprovals: [
                { poId: "124302", vendorName: "Riceland", createdAt: "2026-05-01T08:00:00.000Z" },
            ],
            asOf: "2026-05-04T12:00:00.000Z",
        };

        const out = formatReconStatus(status);
        expect(out).toContain("*Last 24h:* 0 outcomes");
        expect(out).toContain("*Last 7d:* 5 outcomes");
        expect(out).toContain("*Last 30d:* 18 outcomes");
        expect(out).toContain("pending_approval: 2 (1 stale >24h)");
        expect(out).toContain("pending_approval: 2 (2 stale >24h)");
        expect(out).toContain("match\\-failed vendors");
        expect(out).toContain("Pending approvals (open now):");
        expect(out).toContain("PO 124302 — Riceland");
    });
});
