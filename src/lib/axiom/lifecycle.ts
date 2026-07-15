import { upsertFromSource } from "@/lib/intelligence/agent-task";
import { createClient } from "@/lib/db";

export type AxiomLifecycleStatus =
    | "needs_spec"
    | "blocked_duplicate"
    | "ready_for_order_prep";

export type AxiomDraftItem = {
    productId: string;
    quantity: number;
    unitPrice?: number | null;
};

export type AxiomDraftPO = {
    poNumber: string;
    vendorName: string;
    vendorPartyId?: string | null;
    items: AxiomDraftItem[];
};

export type AxiomOrderTemplate = {
    finale_sku: string;
    axiom_job_name?: string | null;
    approved: boolean;
};

export type ActiveAxiomLifecycle = {
    po_number: string;
    status: string;
    finale_skus: string[];
};

export type AxiomDuplicateBlocker = {
    poNumber: string;
    sku: string;
    status: string;
};

export type AxiomDraftAssessment = {
    status: AxiomLifecycleStatus;
    finaleSkus: string[];
    templateSkus: string[];
    missingTemplateSkus: string[];
    duplicateBlockers: AxiomDuplicateBlocker[];
};

const ACTIVE_LIFECYCLE_STATUSES = new Set([
    "needs_spec",
    "blocked_duplicate",
    "ready_for_order_prep",
    "order_prep_started",
    "order_created",
    "invoice_received",
    "po_updated",
    "shipped",
]);

export function isAxiomVendorName(vendorName: string | null | undefined): boolean {
    const name = vendorName || "";
    return /axiom\s*print/i.test(name) || /colorful\s*packaging/i.test(name);
}

function uniqueSorted(values: string[]): string[] {
    return Array.from(new Set(values.map(value => value.trim()).filter(Boolean))).sort();
}

export function assessAxiomDraftPO(args: {
    draft: AxiomDraftPO;
    templates: AxiomOrderTemplate[];
    activeLifecycles: ActiveAxiomLifecycle[];
}): AxiomDraftAssessment {
    const finaleSkus = uniqueSorted(args.draft.items.map(item => item.productId));
    const approvedTemplateSkus = new Set(
        args.templates
            .filter(template => template.approved)
            .map(template => template.finale_sku)
    );

    const templateSkus = finaleSkus.filter(sku => approvedTemplateSkus.has(sku));
    const missingTemplateSkus = finaleSkus.filter(sku => !approvedTemplateSkus.has(sku));

    const duplicateBlockers: AxiomDuplicateBlocker[] = [];
    for (const lifecycle of args.activeLifecycles) {
        if (lifecycle.po_number === args.draft.poNumber) continue;
        if (!ACTIVE_LIFECYCLE_STATUSES.has(lifecycle.status)) continue;

        for (const sku of lifecycle.finale_skus || []) {
            if (finaleSkus.includes(sku)) {
                duplicateBlockers.push({
                    poNumber: lifecycle.po_number,
                    sku,
                    status: lifecycle.status,
                });
            }
        }
    }

    const status: AxiomLifecycleStatus = duplicateBlockers.length > 0
        ? "blocked_duplicate"
        : missingTemplateSkus.length > 0
            ? "needs_spec"
            : "ready_for_order_prep";

    return {
        status,
        finaleSkus,
        templateSkus,
        missingTemplateSkus,
        duplicateBlockers,
    };
}

function goalForAssessment(poNumber: string, assessment: AxiomDraftAssessment, vendorName: string): string {
    const isAxiom = /axiom\s*print/i.test(vendorName);
    const label = isAxiom ? "Axiom" : "Colorful Packaging";

    if (assessment.status === "blocked_duplicate") {
        const blockerList = assessment.duplicateBlockers
            .map(blocker => `${blocker.sku} on PO ${blocker.poNumber}`)
            .join(", ");
        return `Review ${label} draft PO ${poNumber}: SKU already active (${blockerList})`;
    }

    if (assessment.status === "needs_spec") {
        return `Add approved ${label} order specs for ${assessment.missingTemplateSkus.join(", ")} on PO ${poNumber}`;
    }

    return `Prepare ${label} website order for draft PO ${poNumber}`;
}

export async function recordAxiomDraftPOCreated(draft: AxiomDraftPO): Promise<AxiomDraftAssessment | null> {
    if (!isAxiomVendorName(draft.vendorName)) return null;

    const db = createClient();
    if (!db) return null;

    const finaleSkus = uniqueSorted(draft.items.map(item => item.productId));
    if (finaleSkus.length === 0) return null;

    const [templateRes, lifecycleRes] = await Promise.all([
        supabase
            .from("axiom_order_templates")
            .select("finale_sku, axiom_job_name, approved")
            .in("finale_sku", finaleSkus),
        supabase
            .from("axiom_order_lifecycle")
            .select("po_number, status, finale_skus")
            .overlaps("finale_skus", finaleSkus),
    ]);

    if (templateRes.error) throw new Error(templateRes.error.message);
    if (lifecycleRes.error) throw new Error(lifecycleRes.error.message);

    const assessment = assessAxiomDraftPO({
        draft,
        templates: templateRes.data ?? [],
        activeLifecycles: lifecycleRes.data ?? [],
    });

    const now = new Date().toISOString();
    const { error } = await supabase
        .from("axiom_order_lifecycle")
        .upsert({
            po_number: draft.poNumber,
            vendor_name: draft.vendorName,
            vendor_party_id: draft.vendorPartyId ?? null,
            status: assessment.status,
            finale_skus: assessment.finaleSkus,
            items: draft.items,
            template_skus: assessment.templateSkus,
            missing_template_skus: assessment.missingTemplateSkus,
            duplicate_blockers: assessment.duplicateBlockers,
            source: "draft_po_trigger",
            source_ref: `finale:${draft.poNumber}`,
            updated_at: now,
        }, { onConflict: "po_number" });

    if (error) throw new Error(error.message);

    await upsertFromSource({
        sourceTable: "axiom_order_lifecycle",
        sourceId: draft.poNumber,
        type: "manual",
        goal: goalForAssessment(draft.poNumber, assessment, draft.vendorName),
        status: assessment.status === "ready_for_order_prep" ? "PENDING" : "NEEDS_APPROVAL",
        owner: assessment.status === "ready_for_order_prep" ? "aria" : "will",
        priority: assessment.status === "blocked_duplicate" ? 1 : 2,
        requiresApproval: assessment.status !== "ready_for_order_prep",
        inputs: {
            poNumber: draft.poNumber,
            vendorName: draft.vendorName,
            finaleSkus: assessment.finaleSkus,
            missingTemplateSkus: assessment.missingTemplateSkus,
            duplicateBlockers: assessment.duplicateBlockers,
        },
        playbookKind: assessment.status === "ready_for_order_prep" ? "axiom_order_prep" : null,
        playbookState: assessment.status === "ready_for_order_prep" ? "manual_only" : null,
    });

    return assessment;
}

/**
 * Re-assesses any active needs_spec lifecycles that contain the given SKU.
 * This is triggered automatically when a template spec is saved or approved.
 */
export async function reassessActiveLifecyclesForSKU(sku: string): Promise<void> {
    const db = createClient();
    if (!db) return;

    // Find any lifecycle rows in status 'needs_spec' that contain this sku in missing_template_skus
    const { data: lifecycles, error } = await supabase
        .from("axiom_order_lifecycle")
        .select("*")
        .eq("status", "needs_spec")
        .contains("missing_template_skus", [sku]);

    if (error) {
        console.error(`[axiom-lifecycle] Failed to query lifecycles for SKU ${sku}:`, error);
        return;
    }

    if (!lifecycles || lifecycles.length === 0) return;

    for (const row of lifecycles) {
        const draft: AxiomDraftPO = {
            poNumber: row.po_number,
            vendorName: row.vendor_name,
            vendorPartyId: row.vendor_party_id,
            items: row.items as AxiomDraftItem[],
        };
        try {
            console.log(`[axiom-lifecycle] Re-assessing active lifecycle for PO ${row.po_number} due to SKU ${sku} update`);
            await recordAxiomDraftPOCreated(draft);
        } catch (err) {
            console.error(`[axiom-lifecycle] Re-assessment failed for PO ${row.po_number}:`, err);
        }
    }
}

