export type VendorEtaSource =
    | "tracking_eta"
    | "vendor_reply_eta"
    | "vendor_weekday_pattern"
    | "vendor_median"
    | "sku_product"
    | "default";

export interface VendorEtaProfile {
    expectedDate: string;
    source: VendorEtaSource;
    confidence: "high" | "medium" | "low";
    label: string;
    evidence: Array<{ type: VendorEtaSource; detail: string; at?: string | null }>;
}

export interface VendorEtaShipmentSignal {
    estimated_delivery_at: string | null;
    delivered_at: string | null;
    created_at: string;
}

export interface DeriveVendorEtaProfileInput {
    vendorName: string;
    orderDate: string;
    fallbackLeadDays: number;
    fallbackLabel: string;
    fallbackSource?: "vendor_median" | "sku_product" | "default";
    vendorPromisedEta?: string | null;
    shipments: VendorEtaShipmentSignal[];
}

function toDateOnly(value: string | null | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

function addDays(dateOnly: string, days: number): string {
    const date = new Date(`${dateOnly.slice(0, 10)}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function nextWeekday(dateOnly: string, targetDay: number): string {
    const date = new Date(`${dateOnly.slice(0, 10)}T00:00:00.000Z`);
    const currentDay = date.getUTCDay();
    let daysToAdd = (targetDay - currentDay + 7) % 7;
    if (daysToAdd === 0) daysToAdd = 7;
    date.setUTCDate(date.getUTCDate() + daysToAdd);
    return date.toISOString().slice(0, 10);
}

function isUline(vendorName: string): boolean {
    return vendorName.toLowerCase().includes("uline");
}

export function deriveVendorEtaProfile(input: DeriveVendorEtaProfileInput): VendorEtaProfile {
    const liveTrackingEta = input.shipments
        .map((shipment) => toDateOnly(shipment.estimated_delivery_at))
        .filter((value): value is string => Boolean(value))
        .sort()[0];

    if (liveTrackingEta) {
        return {
            expectedDate: liveTrackingEta,
            source: "tracking_eta",
            confidence: "high",
            label: `ETA ${liveTrackingEta} - tracking`,
            evidence: [{ type: "tracking_eta", detail: "Carrier tracking provided an estimated delivery date" }],
        };
    }

    const vendorEta = toDateOnly(input.vendorPromisedEta);
    if (vendorEta) {
        return {
            expectedDate: vendorEta,
            source: "vendor_reply_eta",
            confidence: "medium",
            label: `ETA ${vendorEta} - vendor reply`,
            evidence: [{ type: "vendor_reply_eta", detail: "Vendor reply included an ETA", at: input.vendorPromisedEta }],
        };
    }

    if (isUline(input.vendorName)) {
        const order = new Date(`${input.orderDate.slice(0, 10)}T00:00:00.000Z`);
        const expectedDate = order.getUTCDay() === 5
            ? nextWeekday(input.orderDate, 2)
            : addDays(input.orderDate, 4);
        const label = order.getUTCDay() === 5
            ? "Tue - ULINE Fri -> Tue pattern"
            : "4d - ULINE fast-ship pattern";
        return {
            expectedDate,
            source: "vendor_weekday_pattern",
            confidence: "high",
            label,
            evidence: [{ type: "vendor_weekday_pattern", detail: "ULINE is treated as a fast-ship anomaly" }],
        };
    }

    const fallbackSource = input.fallbackSource ?? "default";
    return {
        expectedDate: addDays(input.orderDate, input.fallbackLeadDays),
        source: fallbackSource,
        confidence: fallbackSource === "default" ? "low" : "medium",
        label: input.fallbackLabel,
        evidence: [{ type: fallbackSource, detail: input.fallbackLabel }],
    };
}
