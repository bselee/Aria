/**
 * @file    src/lib/intelligence/proactive-brief.ts
 * @purpose Daily proactive morning brief — single Telegram message at 7 AM
 *          that synthesizes what Bill needs to act on TODAY from across all
 *          Aria subsystems. Not a summary of summaries — a prioritized
 *          action list with only items that require human decision.
 *
 * Layers pulled (each queries independently):
 *   1. JIT triggers — SKUs whose order-trigger-date hits in next 48h
 *   2. Overdue POs — past expectedReceiveDate, 0 items received
 *   3. Pending approvals — reconciliations waiting on Bill's Telegram vote
 *   4. Vendor escalation — L2/L3 drafts queued in Gmail, ready to send
 *   5. Consumption spike — SKU velocity doubled vs 30d average in last 7d
 *
 * If ALL layers return nothing, the brief sends nothing. Zero noise.
 */

import { createClient } from "@/lib/db";
import { notifyViaTask } from "./notify-via-task";

interface BriefSection {
    label: string;
    emoji: string;
    lines: string[];
}

// ── 1. JIT triggers (next 48h) ─────────────────────────────────────────

async function jitTriggersSection(): Promise<BriefSection | null> {
    const sb = createClient();
    if (!sb) return null;

    const today = new Date();
    const in48h = new Date(today.getTime() + 2 * 86_400_000);
    const todayIso = today.toISOString().slice(0, 10);
    const in48hIso = in48h.toISOString().slice(0, 10);

    const { data, error } = await sb
        .from("build_risk_snapshot")
        .select("sku, component_name, vendor_name, order_trigger_date, risk_level")
        .gte("order_trigger_date", todayIso)
        .lte("order_trigger_date", in48hIso)
        .order("order_trigger_date", { ascending: true })
        .limit(10);

    if (error || !data?.length) return null;

    const lines = data.map((r: any) => {
        const d = r.order_trigger_date;
        const tag = d === todayIso ? "TODAY" : `${d}`;
        return `  \`${r.sku}\` by ${tag}`;
    });

    return { label: "Order Trigger — Next 48h", emoji: "📅", lines };
}

// ── 2. Overdue POs ─────────────────────────────────────────────────────

async function overduePOsSection(): Promise<BriefSection | null> {
    const sb = createClient();
    if (!sb) return null;

    const todayIso = new Date().toISOString().slice(0, 10);

    // POs past expected receive date, status != Received, no items received
    const { data, error } = await sb
        .from("purchase_orders")
        .select("po_number, vendor_name, expected_receive_date")
        .lt("expected_receive_date", todayIso)
        .neq("status", "Received")
        .neq("status", "Closed")
        .order("expected_receive_date", { ascending: true })
        .limit(10);

    if (error || !data?.length) return null;

    const today = new Date();
    const lines = data.map((r: any) => {
        const overdue = Math.floor(
            (today.getTime() - new Date(r.expected_receive_date).getTime()) / 86_400_000
        );
        return `  ${r.po_number} — ${r.vendor_name ?? "?"} _(${overdue}d overdue)_`;
    });

    return { label: "Overdue POs", emoji: "⚠️", lines };
}

// ── 3. Pending reconciliations ─────────────────────────────────────────

async function pendingApprovalsSection(): Promise<BriefSection | null> {
    const sb = createClient();
    if (!sb) return null;

    const { count, error } = await sb
        .from("ap_pending_approvals")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending");

    if (error || !count || count === 0) return null;

    return {
        label: "Pending Approvals",
        emoji: "✋",
        lines: [`  ${count} reconciliation(s) awaiting your vote on Telegram`],
    };
}

// ── 4. Vendor escalation drafts ────────────────────────────────────────

async function escalationSection(): Promise<BriefSection | null> {
    const sb = createClient();
    if (!sb) return null;

    const { data, error } = await sb
        .from("purchase_orders")
        .select("po_number, vendor_name, followup_level")
        .in("followup_level", ["l2", "l3"])
        .limit(10);

    if (error || !data?.length) return null;

    const l2 = data.filter((r: any) => r.followup_level === "l2");
    const l3 = data.filter((r: any) => r.followup_level === "l3");

    const lines: string[] = [];
    if (l2.length) lines.push(`  L2 drafts queued: ${l2.map((r: any) => r.po_number).join(", ")}`);
    if (l3.length) lines.push(`  🚨 L3 (consider alt vendor): ${l3.map((r: any) => `${r.po_number}/${r.vendor_name}`).join(", ")}`);
    if (!lines.length) return null;

    return { label: "Vendor Escalations", emoji: "📡", lines };
}

// ── 5. Consumption spike detection ────────────────────────────────────

async function consumptionSpikeSection(): Promise<BriefSection | null> {
    const sb = createClient();
    if (!sb) return null;

    // Compare last 7 days consumption vs. 30-day average per SKU.
    // A SKU is "spiking" if 7d rate > 2× the 30d average AND stock < 14d runway at 7d rate.
    const now = Date.now();
    const d7ago = new Date(now - 7 * 86_400_000).toISOString();
    const d30ago = new Date(now - 30 * 86_400_000).toISOString();

    // Get recent consumption (outbound qty from shipment_items or inventory_adjustments)
    const { data: recent, error: rErr } = await sb
        .from("inventory_adjustments")
        .select("sku, quantity, created_at")
        .eq("adjustment_type", "SALE")
        .gte("created_at", d30ago)
        .limit(5000);

    if (rErr || !recent?.length) return null;

    // Bucket by sku + period
    const buckets: Record<string, { recent7: number; recent30: number }> = {};
    for (const row of recent as any[]) {
        const sku = row.sku;
        if (!sku) continue;
        if (!buckets[sku]) buckets[sku] = { recent7: 0, recent30: 0 };
        const qty = Math.abs(row.quantity ?? 0);
        if (row.created_at >= d7ago) buckets[sku].recent7 += qty;
        buckets[sku].recent30 += qty;
    }

    const spikes: string[] = [];
    for (const [sku, b] of Object.entries(buckets)) {
        const avg30 = b.recent30 / 30;   // daily avg over 30d
        const avg7 = b.recent7 / 7;     // daily avg over 7d
        if (avg30 < 0.5) continue;      // too noisy at sub-1/day
        if (avg7 > avg30 * 2 && avg7 >= 1) {
            const ratio = (avg7 / avg30).toFixed(1);
            spikes.push(`  \`${sku}\` — ${ratio}× normal velocity`);
            if (spikes.length >= 5) break;
        }
    }

    if (!spikes.length) return null;
    return { label: "Consumption Spike", emoji: "📈", lines: spikes };
}

// ── Orchestrator ───────────────────────────────────────────────────────

/**
 * Generate and send the daily proactive brief. Called from cron at 7 AM.
 * Queries all layers, builds a prioritized action list, routes via notifyViaTask.
 * If nothing actionable, sends nothing.
 */
export async function generateProactiveBrief(): Promise<void> {
    const results = await Promise.allSettled([
        jitTriggersSection(),
        overduePOsSection(),
        pendingApprovalsSection(),
        escalationSection(),
        consumptionSpikeSection(),
    ]);

    const sections = results
        .map(r => (r.status === "fulfilled" ? r.value : null))
        .filter((s): s is BriefSection => s !== null);

    if (sections.length === 0) {
        console.log("[proactive-brief] All clear — nothing actionable today. No Telegram sent.");
        return;
    }

    const totalLines = sections.reduce((sum, s) => sum + s.lines.length, 0);
    const dateStr = new Date().toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        timeZone: "America/Denver",
    });

    const goalLines: string[] = [
        `🎯 *Morning Brief — ${dateStr}*`,
        `${sections.length} area(s) need your attention:`,
        "",
    ];

    for (const section of sections) {
        goalLines.push(`${section.emoji} *${section.label}*`);
        goalLines.push(...section.lines);
        goalLines.push("");
    }

    goalLines.push("_All other systems green. Nothing else queued._");

    const goal = goalLines.join("\n");

    await notifyViaTask({
        sourceId: `proactive-brief:${new Date().toISOString().slice(0, 10)}`,
        type: "cron_summary",
        goal,
        inputs: {
            date: dateStr,
            sectionCount: sections.length,
            totalLines,
            sections: sections.map(s => ({ label: s.label, lineCount: s.lines.length })),
        },
        priority: 1,
        summaryLabel: "Morning Brief",
    });

    console.log(`[proactive-brief] Sent: ${sections.length} sections, ${totalLines} items.`);
}
