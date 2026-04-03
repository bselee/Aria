import { createClient } from "@/lib/supabase";
import { FinaleClient } from "@/lib/finale/client";
import {
    carrierUrl,
    detectCarrier,
    getTrackingStatus,
    TRACKING_PATTERNS,
    type TrackingCategory,
    type TrackingStatus,
} from "@/lib/carriers/tracking-service";

export type ShipmentTrackingKind = "parcel" | "ltl_pro" | "ltl_bol" | "unknown";

export interface ShipmentSourceRef {
    source: string;
    sourceRef?: string | null;
    seenAt: string;
    confidence?: number | null;
}

export interface ShipmentRecord {
    id: string;
    tracking_key: string;
    tracking_number: string;
    normalized_tracking_number: string;
    carrier_name: string | null;
    carrier_key: string | null;
    tracking_kind: ShipmentTrackingKind;
    po_numbers: string[];
    vendor_names: string[];
    status_category: TrackingCategory | null;
    status_display: string | null;
    public_tracking_url: string | null;
    estimated_delivery_at: string | null;
    delivered_at: string | null;
    last_checked_at: string | null;
    last_source: string | null;
    source_confidence: number | null;
    source_refs: ShipmentSourceRef[];
    active: boolean;
    created_at: string;
    updated_at: string;
}

export interface ShipmentUpsertInput {
    trackingNumber: string;
    poNumber?: string | null;
    vendorName?: string | null;
    source: string;
    sourceRef?: string | null;
    confidence?: number | null;
    statusCategory?: TrackingCategory | null;
    statusDisplay?: string | null;
    estimatedDeliveryAt?: string | null;
    deliveredAt?: string | null;
    publicTrackingUrl?: string | null;
    active?: boolean;
}

export interface ShipmentRollup {
    id: string;
    poNumbers: string[];
    vendorNames: string[];
    trackingNumber: string;
    carrierName: string | null;
    carrierKey: string | null;
    trackingKind: ShipmentTrackingKind;
    statusCategory: TrackingCategory | "unknown";
    statusDisplay: string;
    estimatedDeliveryAt: string | null;
    deliveredAt: string | null;
    publicTrackingUrl: string | null;
    freshnessMinutes: number | null;
    lastCheckedAt: string | null;
}

export interface ShipmentBoardBuckets {
    arrivingToday: ShipmentRollup[];
    outForDelivery: ShipmentRollup[];
    deliveredAwaitingReceipt: ShipmentRollup[];
    exceptions: ShipmentRollup[];
    stale: ShipmentRollup[];
    recentlyDelivered: ShipmentRollup[];
}

export interface BestTrackingAnswer {
    primaryLine: string;
    metaLine: string;
    shipments: ShipmentRollup[];
}

export interface DashboardTrackingBoardResult {
    board: ShipmentBoardBuckets;
    shipments: ShipmentRollup[];
    asOf: string;
}

export interface TodayShipmentSummary {
    headline: string;
    lines: string[];
}

const STALE_MINUTES = 24 * 60;
const RECENT_DELIVERED_HOURS = 72;
const ACTIVE_REFRESH_MINUTES = 60;
const DELIVERED_REFRESH_MINUTES = 6 * 60;
const DEFAULT_REFRESH_LIMIT = 12;
const QUERY_STOP_WORDS = new Set([
    "a",
    "an",
    "for",
    "find",
    "is",
    "me",
    "of",
    "shipment",
    "shipping",
    "show",
    "status",
    "the",
    "track",
    "tracking",
    "what",
    "when",
    "where",
]);

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const raw of values) {
        const value = String(raw || "").trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(value);
    }

    return result;
}

function isMissingShipmentsTableError(message: string | null | undefined): boolean {
    const normalized = String(message || "").toLowerCase();
    return normalized.includes("could not find the table 'public.shipments'") ||
        normalized.includes("relation \"public.shipments\" does not exist") ||
        normalized.includes("relation \"shipments\" does not exist");
}

function toIsoOrNull(value: string | null | undefined): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
}

function titleCaseCarrierName(value: string | null): string | null {
    if (!value) return null;
    const normalized = value.toLowerCase();
    if (normalized === "fedex") return "FedEx";
    if (normalized === "ups") return "UPS";
    if (normalized === "usps") return "USPS";
    if (normalized === "dhl") return "DHL";
    return value
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function parseDisplayDates(display: string): { estimatedDeliveryAt?: string | null; deliveredAt?: string | null } {
    const dateMatch = display.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}/i);
    if (!dateMatch) return {};

    const monthDay = dateMatch[0];
    const currentYear = new Date().getUTCFullYear();
    const parsed = new Date(`${monthDay}, ${currentYear} 17:00:00 UTC`);
    if (Number.isNaN(parsed.getTime())) return {};

    if (/delivered/i.test(display)) {
        return { deliveredAt: parsed.toISOString() };
    }

    if (/expected/i.test(display) || /delivery/i.test(display)) {
        return { estimatedDeliveryAt: parsed.toISOString() };
    }

    return {};
}

export function normalizeTrackingIdentity(trackingNumber: string): {
    trackingNumber: string;
    normalizedTrackingNumber: string;
    trackingKey: string;
    carrierName: string | null;
    carrierKey: string | null;
    trackingKind: ShipmentTrackingKind;
    publicTrackingUrl: string | null;
} {
    const trimmed = String(trackingNumber || "").trim();
    if (!trimmed) {
        throw new Error("Tracking number is required");
    }

    if (trimmed.includes(":::")) {
        const [carrierNameRaw, actualNumberRaw] = trimmed.split(":::", 2);
        const carrierName = titleCaseCarrierName(carrierNameRaw.trim()) || "Freight";
        const actualNumber = actualNumberRaw.trim();
        const kind: ShipmentTrackingKind = "ltl_pro";
        return {
            trackingNumber: `${carrierName}:::${actualNumber}`,
            normalizedTrackingNumber: actualNumber,
            trackingKey: `${carrierName.toLowerCase()}:${actualNumber.toLowerCase()}`,
            carrierName,
            carrierKey: carrierName.toLowerCase(),
            trackingKind: kind,
            publicTrackingUrl: carrierUrl(`${carrierName}:::${actualNumber}`),
        };
    }

    const normalizedTrackingNumber = trimmed.toUpperCase();
    const carrierKey = detectCarrier(normalizedTrackingNumber);
    const carrierName = carrierKey ? titleCaseCarrierName(carrierKey) : null;

    return {
        trackingNumber: normalizedTrackingNumber,
        normalizedTrackingNumber,
        trackingKey: `${carrierKey || "unknown"}:${normalizedTrackingNumber.toLowerCase()}`,
        carrierName,
        carrierKey,
        trackingKind: carrierKey ? "parcel" : "unknown",
        publicTrackingUrl: carrierUrl(normalizedTrackingNumber),
    };
}

export function mergeShipmentEvidence(
    existing: ShipmentRecord,
    update: Omit<ShipmentUpsertInput, "trackingNumber">,
): ShipmentRecord {
    const now = new Date().toISOString();
    const nextSourceRefs = [...(existing.source_refs || [])];

    if (update.source) {
        const alreadySeen = nextSourceRefs.some((ref) => ref.source === update.source && ref.sourceRef === (update.sourceRef || null));
        if (!alreadySeen) {
            nextSourceRefs.push({
                source: update.source,
                sourceRef: update.sourceRef || null,
                seenAt: now,
                confidence: update.confidence ?? null,
            });
        }
    }

    return {
        ...existing,
        po_numbers: uniqueStrings([...existing.po_numbers, update.poNumber]),
        vendor_names: uniqueStrings([...existing.vendor_names, update.vendorName]),
        status_category: update.statusCategory ?? existing.status_category,
        status_display: update.statusDisplay ?? existing.status_display,
        estimated_delivery_at: toIsoOrNull(update.estimatedDeliveryAt) ?? existing.estimated_delivery_at,
        delivered_at: toIsoOrNull(update.deliveredAt) ?? existing.delivered_at,
        public_tracking_url: update.publicTrackingUrl ?? existing.public_tracking_url,
        last_source: update.source || existing.last_source,
        source_confidence: Math.max(existing.source_confidence || 0, update.confidence || 0) || null,
        source_refs: nextSourceRefs,
        active: update.active ?? existing.active,
        updated_at: now,
    };
}

function statusCategoryOrUnknown(status: string | null | undefined): TrackingCategory | "unknown" {
    if (status === "delivered" || status === "out_for_delivery" || status === "in_transit" || status === "exception") {
        return status;
    }
    return "unknown";
}

function rollupShipment(record: ShipmentRecord, nowIso: string): ShipmentRollup {
    const freshnessMinutes = record.last_checked_at
        ? Math.max(0, Math.round((new Date(nowIso).getTime() - new Date(record.last_checked_at).getTime()) / 60000))
        : null;

    return {
        id: record.id,
        poNumbers: record.po_numbers || [],
        vendorNames: record.vendor_names || [],
        trackingNumber: record.tracking_number,
        carrierName: record.carrier_name,
        carrierKey: record.carrier_key,
        trackingKind: record.tracking_kind,
        statusCategory: statusCategoryOrUnknown(record.status_category),
        statusDisplay: record.status_display || "Awaiting update",
        estimatedDeliveryAt: record.estimated_delivery_at,
        deliveredAt: record.delivered_at,
        publicTrackingUrl: record.public_tracking_url,
        freshnessMinutes,
        lastCheckedAt: record.last_checked_at,
    };
}

function isSameDenverDate(aIso: string | null | undefined, bIso: string | null | undefined): boolean {
    if (!aIso || !bIso) return false;
    const a = new Date(aIso).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    const b = new Date(bIso).toLocaleDateString("en-CA", { timeZone: "America/Denver" });
    return a === b;
}

export function getShipmentBoardBuckets(
    shipments: ShipmentRecord[],
    opts: { now?: string; receivedPoNumbers?: Set<string> } = {},
): ShipmentBoardBuckets {
    const nowIso = opts.now || new Date().toISOString();
    const receivedPoNumbers = opts.receivedPoNumbers || new Set<string>();
    const now = new Date(nowIso);
    const deliveredCutoff = new Date(now.getTime() - RECENT_DELIVERED_HOURS * 60 * 60 * 1000).toISOString();

    const rollups = shipments
        .filter((shipment) => shipment.active !== false)
        .map((shipment) => rollupShipment(shipment, nowIso));

    return {
        arrivingToday: rollups.filter((shipment) =>
            shipment.statusCategory === "in_transit" &&
            isSameDenverDate(shipment.estimatedDeliveryAt, nowIso),
        ),
        outForDelivery: rollups.filter((shipment) => shipment.statusCategory === "out_for_delivery"),
        deliveredAwaitingReceipt: rollups.filter((shipment) =>
            shipment.statusCategory === "delivered" &&
            !shipment.poNumbers.some((poNumber) => receivedPoNumbers.has(poNumber)),
        ),
        exceptions: rollups.filter((shipment) => shipment.statusCategory === "exception"),
        stale: rollups.filter((shipment) =>
            shipment.statusCategory !== "delivered" &&
            (shipment.freshnessMinutes ?? STALE_MINUTES + 1) > STALE_MINUTES,
        ),
        recentlyDelivered: rollups.filter((shipment) =>
            shipment.statusCategory === "delivered" &&
            !!shipment.deliveredAt &&
            shipment.deliveredAt >= deliveredCutoff,
        ),
    };
}

export function buildBestTrackingAnswer(opts: {
    query: string;
    shipments: ShipmentRecord[];
    now?: string;
}): BestTrackingAnswer | null {
    const nowIso = opts.now || new Date().toISOString();
    const query = (opts.query || "").trim().toLowerCase();
    if (!query) return null;
    const queryTokens = query
        .split(/[^a-z0-9-]+/i)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token && !QUERY_STOP_WORDS.has(token) && token.length >= 2);

    const matches = opts.shipments
        .map((shipment) => ({
            shipment,
            score: scoreShipmentMatch(shipment, query, queryTokens),
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;

            const aFresh = rollupShipment(a.shipment, nowIso).freshnessMinutes ?? Number.MAX_SAFE_INTEGER;
            const bFresh = rollupShipment(b.shipment, nowIso).freshnessMinutes ?? Number.MAX_SAFE_INTEGER;
            return aFresh - bFresh;
        })
        .map((candidate) => candidate.shipment);

    if (matches.length === 0) return null;

    const rollups = matches.map((shipment) => rollupShipment(shipment, nowIso));
    const top = rollups[0];
    const poLabel = top.poNumbers[0] || "Shipment";
    const vendorLabel = top.vendorNames[0] || top.carrierName || "Unknown vendor";
    const freshnessLabel = top.freshnessMinutes == null
        ? "freshness unknown"
        : top.freshnessMinutes < 60
            ? `fresh ${top.freshnessMinutes}m ago`
            : `fresh ${Math.round(top.freshnessMinutes / 60)}h ago`;
    const etaLabel = top.estimatedDeliveryAt
        ? ` ETA ${new Date(top.estimatedDeliveryAt).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
        })}`
        : "";

    return {
        primaryLine: `${poLabel} - ${top.statusDisplay} (${vendorLabel})${etaLabel}`,
        metaLine: `${freshnessLabel}${top.trackingNumber ? ` - ${top.trackingNumber}` : ""}`,
        shipments: rollups,
    };
}

function formatSummaryEta(value: string | null | undefined): string {
    if (!value) return "";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

export function buildTodayShipmentSummary(board: ShipmentBoardBuckets): TodayShipmentSummary | null {
    const outForDelivery = board.outForDelivery || [];
    const arrivingToday = board.arrivingToday || [];
    const total = outForDelivery.length + arrivingToday.length;
    if (total === 0) return null;

    const headlineParts: string[] = [];
    if (outForDelivery.length > 0) {
        headlineParts.push(`${outForDelivery.length} out for delivery`);
    }
    if (arrivingToday.length > 0) {
        headlineParts.push(`${arrivingToday.length} arriving today`);
    }

    const lines = [...outForDelivery, ...arrivingToday]
        .slice(0, 4)
        .map((shipment) => {
            const poLabel = shipment.poNumbers[0] || shipment.trackingNumber;
            const vendorLabel = shipment.vendorNames[0] || shipment.carrierName || "Unknown vendor";
            const suffix = shipment.statusCategory === "out_for_delivery"
                ? "Out for delivery"
                : shipment.estimatedDeliveryAt
                    ? `ETA ${formatSummaryEta(shipment.estimatedDeliveryAt)}`
                    : shipment.statusDisplay;
            return `${poLabel} - ${vendorLabel} - ${suffix}`;
        });

    return {
        headline: headlineParts.join(", "),
        lines,
    };
}

function scoreFieldMatch(
    values: Array<string | null | undefined>,
    query: string,
    queryTokens: string[],
    exactWeight: number,
    containsWeight: number,
): number {
    let score = 0;
    const normalizedValues = values
        .map((value) => String(value || "").trim().toLowerCase())
        .filter(Boolean);

    for (const value of normalizedValues) {
        if (value === query) {
            score += exactWeight * 2;
        } else if (query.length >= 4 && value.includes(query)) {
            score += exactWeight;
        }

        for (const token of queryTokens) {
            if (value === token) {
                score += exactWeight;
            } else if (value.includes(token)) {
                score += containsWeight;
            }
        }
    }

    return score;
}

export function normalizePoString(po: string | null | undefined): string {
    if (!po) return "";
    let clean = po.trim().toUpperCase();
    // Strip common prefixes: PO-, PO, ORDER, #
    clean = clean.replace(/^(PO[-\s]?|ORDER[-\s]?|#)/i, "");
    return clean.trim();
}

function scoreShipmentMatch(shipment: ShipmentRecord, query: string, queryTokens: string[]): number {
    const rawPos = shipment.po_numbers || [];
    const normalizedPos = rawPos.map(normalizePoString).filter(Boolean);
    const combinedPos = Array.from(new Set([...rawPos, ...normalizedPos]));

    const normalQuery = normalizePoString(query);
    const normalTokens = queryTokens.map(normalizePoString).filter(Boolean);
    const combinedTokens = Array.from(new Set([...queryTokens, ...normalTokens]));

    return (
        Math.max(
            scoreFieldMatch(combinedPos, query, combinedTokens, 120, 45),
            normalQuery ? scoreFieldMatch(combinedPos, normalQuery, combinedTokens, 120, 45) : 0
        ) +
        scoreFieldMatch(
            [shipment.tracking_number, shipment.normalized_tracking_number],
            query,
            queryTokens,
            110,
            40,
        ) +
        scoreFieldMatch(shipment.vendor_names || [], query, queryTokens, 70, 20) +
        scoreFieldMatch([shipment.carrier_name], query, queryTokens, 40, 15)
    );
}

function getRefreshAgeMinutes(lastCheckedAt: string | null | undefined, nowIso: string): number | null {
    if (!lastCheckedAt) return null;
    const diffMs = new Date(nowIso).getTime() - new Date(lastCheckedAt).getTime();
    if (Number.isNaN(diffMs)) return null;
    return Math.max(0, Math.round(diffMs / 60000));
}

function shouldRefreshShipment(record: ShipmentRecord, nowIso: string): boolean {
    if (record.active === false) return false;

    const ageMinutes = getRefreshAgeMinutes(record.last_checked_at, nowIso);
    if (record.status_category === "delivered") {
        return ageMinutes == null || ageMinutes >= DELIVERED_REFRESH_MINUTES;
    }

    return ageMinutes == null || ageMinutes >= ACTIVE_REFRESH_MINUTES;
}

export function getShipmentsDueForRefresh(
    shipments: ShipmentRecord[],
    opts: { now?: string; limit?: number } = {},
): ShipmentRecord[] {
    const nowIso = opts.now || new Date().toISOString();
    const limit = opts.limit ?? DEFAULT_REFRESH_LIMIT;

    return shipments
        .filter((shipment) => shouldRefreshShipment(shipment, nowIso))
        .sort((a, b) => {
            const aUnchecked = a.last_checked_at ? 0 : 1;
            const bUnchecked = b.last_checked_at ? 0 : 1;
            if (bUnchecked !== aUnchecked) return bUnchecked - aUnchecked;

            const statusPriority = (status: ShipmentRecord["status_category"]) => {
                if (status === "out_for_delivery") return 4;
                if (status === "exception") return 3;
                if (status === "in_transit") return 2;
                if (status === "delivered") return 1;
                return 0;
            };

            const aStatus = statusPriority(a.status_category);
            const bStatus = statusPriority(b.status_category);
            if (bStatus !== aStatus) return bStatus - aStatus;

            const aAge = getRefreshAgeMinutes(a.last_checked_at, nowIso) ?? Number.MAX_SAFE_INTEGER;
            const bAge = getRefreshAgeMinutes(b.last_checked_at, nowIso) ?? Number.MAX_SAFE_INTEGER;
            return bAge - aAge;
        })
        .slice(0, limit);
}

async function syncLegacyPurchaseOrderTracking(poNumber: string): Promise<void> {
    const supabase = createClient();
    if (!supabase || !poNumber) return;

    const { data: shipments } = await supabase
        .from("shipments")
        .select("tracking_number, public_tracking_url")
        .contains("po_numbers", [poNumber])
        .eq("active", true);

    const trackingNumbers = uniqueStrings((shipments || []).map((s: any) => s.tracking_number));
    const publicUrls = uniqueStrings((shipments || []).map((s: any) => s.public_tracking_url));

    // 1. Sync to local Supabase cache
    await supabase
        .from("purchase_orders")
        .upsert({
            po_number: poNumber,
            tracking_numbers: trackingNumbers,
            updated_at: new Date().toISOString(),
        }, { onConflict: "po_number" });

    // 2. Sync bidirectional back to Finale custom fields
    if (trackingNumbers.length > 0) {
        try {
            const finale = new FinaleClient();
            await finale.updatePurchaseOrderTracking(
                poNumber,
                trackingNumbers.join(", "),
                publicUrls.join(", ")
            );
        } catch (err: any) {
            console.warn(`[tracking-sync] Failed bidirectional Finale sync for PO ${poNumber}: ${err.message}`);
        }
    }
}

function isReceivedPurchaseOrderStatus(status: string | null | undefined): boolean {
    const normalized = String(status || "").toLowerCase();
    return normalized === "received" || normalized === "completed";
}

export async function upsertShipmentEvidence(input: ShipmentUpsertInput): Promise<ShipmentRecord | null> {
    const supabase = createClient();
    if (!supabase) return null;

    const normalized = normalizeTrackingIdentity(input.trackingNumber);
    const { data: existing } = await supabase
        .from("shipments")
        .select("*")
        .eq("tracking_key", normalized.trackingKey)
        .maybeSingle();

    const now = new Date().toISOString();
    const baseRecord: ShipmentRecord = {
        id: existing?.id || normalized.trackingKey,
        tracking_key: normalized.trackingKey,
        tracking_number: normalized.trackingNumber,
        normalized_tracking_number: normalized.normalizedTrackingNumber,
        carrier_name: normalized.carrierName,
        carrier_key: normalized.carrierKey,
        tracking_kind: normalized.trackingKind,
        po_numbers: uniqueStrings([input.poNumber]),
        vendor_names: uniqueStrings([input.vendorName]),
        status_category: input.statusCategory ?? null,
        status_display: input.statusDisplay ?? null,
        public_tracking_url: input.publicTrackingUrl ?? normalized.publicTrackingUrl,
        estimated_delivery_at: toIsoOrNull(input.estimatedDeliveryAt),
        delivered_at: toIsoOrNull(input.deliveredAt),
        last_checked_at: null,
        last_source: input.source,
        source_confidence: input.confidence ?? null,
        source_refs: input.source ? [{
            source: input.source,
            sourceRef: input.sourceRef || null,
            seenAt: now,
            confidence: input.confidence ?? null,
        }] : [],
        active: input.active ?? true,
        created_at: existing?.created_at || now,
        updated_at: now,
    };

    const merged = existing
        ? mergeShipmentEvidence(existing as ShipmentRecord, input)
        : baseRecord;

    const { data, error } = await supabase
        .from("shipments")
        .upsert(merged, { onConflict: "tracking_key" })
        .select("*")
        .single();

    if (error) {
        throw new Error(`Shipment upsert failed: ${error.message}`);
    }

    if (input.poNumber) {
        await syncLegacyPurchaseOrderTracking(input.poNumber);
    }

    return data as ShipmentRecord;
}

function mergeTrackingStatus(record: ShipmentRecord, status: TrackingStatus | null): ShipmentRecord {
    if (!status) return record;

    const parsedDates = parseDisplayDates(status.display);
    return {
        ...record,
        status_category: status.category,
        status_display: status.display,
        public_tracking_url: status.public_url || record.public_tracking_url,
        estimated_delivery_at: status.estimated_delivery_at || parsedDates.estimatedDeliveryAt || record.estimated_delivery_at,
        delivered_at: status.delivered_at || parsedDates.deliveredAt || record.delivered_at,
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
}

export async function refreshShipmentStatus(record: ShipmentRecord): Promise<ShipmentRecord> {
    const supabase = createClient();
    if (!supabase) return record;

    const status = await getTrackingStatus(record.tracking_number);
    const updated = mergeTrackingStatus(record, status);

    const { data, error } = await supabase
        .from("shipments")
        .update(updated)
        .eq("tracking_key", record.tracking_key)
        .select("*")
        .single();

    if (error) {
        throw new Error(`Shipment refresh failed: ${error.message}`);
    }

    return data as ShipmentRecord;
}

export async function listShipmentsForPurchaseOrders(poNumbers: string[]): Promise<ShipmentRecord[]> {
    const supabase = createClient();
    if (!supabase || poNumbers.length === 0) return [];

    const { data, error } = await supabase
        .from("shipments")
        .select("*")
        .overlaps("po_numbers", poNumbers)
        .eq("active", true)
        .order("updated_at", { ascending: false });

    if (error) {
        if (isMissingShipmentsTableError(error.message)) {
            return [];
        }
        throw new Error(`Shipment load failed: ${error.message}`);
    }

    return refreshDueShipments((data || []) as ShipmentRecord[]);
}

async function getReceivedPoNumbers(poNumbers: string[]): Promise<Set<string>> {
    const supabase = createClient();
    if (!supabase || poNumbers.length === 0) return new Set<string>();

    const received = new Set<string>();

    for (let i = 0; i < poNumbers.length; i += 100) {
        const chunk = poNumbers.slice(i, i + 100);
        const { data, error } = await supabase
            .from("purchase_orders")
            .select("po_number, status")
            .in("po_number", chunk);

        if (error) {
            throw new Error(`Received PO load failed: ${error.message}`);
        }

        for (const row of data || []) {
            if (row?.po_number && isReceivedPurchaseOrderStatus(row.status)) {
                received.add(row.po_number);
            }
        }
    }

    return received;
}

async function listActiveShipmentsRaw(): Promise<ShipmentRecord[]> {
    const supabase = createClient();
    if (!supabase) return [];

    const { data, error } = await supabase
        .from("shipments")
        .select("*")
        .eq("active", true)
        .order("updated_at", { ascending: false })
        .limit(300);

    if (error) {
        if (isMissingShipmentsTableError(error.message)) {
            return [];
        }
        throw new Error(`Shipment board load failed: ${error.message}`);
    }

    return (data || []) as ShipmentRecord[];
}

export async function refreshActiveShipmentsBackgroundJob(): Promise<void> {
    try {
        const shipments = await listActiveShipmentsRaw();
        await refreshDueShipments(shipments);
    } catch (err: any) {
        console.error(`[shipment-refresh-job] Failed to refresh active shipments: ${err.message}`);
    }
}

async function refreshDueShipments(shipments: ShipmentRecord[]): Promise<ShipmentRecord[]> {
    const dueShipments = getShipmentsDueForRefresh(shipments, { limit: DEFAULT_REFRESH_LIMIT });
    if (dueShipments.length === 0) return shipments;

    const refreshed = new Map<string, ShipmentRecord>();

    for (const shipment of dueShipments) {
        try {
            const updated = await refreshShipmentStatus(shipment);
            refreshed.set(updated.tracking_key, updated);
        } catch (err: any) {
            console.warn(`[tracking-board] Shipment refresh failed for ${shipment.tracking_number}: ${err.message}`);
        }
    }

    if (refreshed.size === 0) return shipments;

    return shipments
        .map((shipment) => refreshed.get(shipment.tracking_key) || shipment)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

async function listActiveShipmentsForRead(): Promise<ShipmentRecord[]> {
    const shipments = await listActiveShipmentsRaw();
    return refreshDueShipments(shipments);
}

export async function getDashboardTrackingBoard(): Promise<DashboardTrackingBoardResult> {
    const shipments = await listActiveShipmentsForRead();
    const nowIso = new Date().toISOString();
    const deliveredPoNumbers = uniqueStrings(
        shipments
            .filter((shipment) => shipment.status_category === "delivered")
            .flatMap((shipment) => shipment.po_numbers || []),
    );
    const receivedPoNumbers = await getReceivedPoNumbers(deliveredPoNumbers);
    const board = getShipmentBoardBuckets(shipments, { now: nowIso, receivedPoNumbers });
    return {
        board,
        shipments: shipments.map((shipment) => rollupShipment(shipment, nowIso)),
        asOf: nowIso,
    };
}

export async function getBestTrackingAnswerForQuery(query: string): Promise<BestTrackingAnswer | null> {
    const shipments = await listActiveShipmentsForRead();
    return buildBestTrackingAnswer({
        query,
        shipments,
        now: new Date().toISOString(),
    });
}
