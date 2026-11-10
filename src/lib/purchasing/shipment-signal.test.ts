/**
 * @file shipment-signal.test.ts
 * @purpose Lock the merge rules: latest delivery wins, earliest live ETA wins.
 * @author Hermia
 * @created 2026-11-09
 * @deps vitest, ./shipment-signal
 */

import { describe, expect, it } from "vitest";
import { mergeSignal, trackingSuffix, type ShipmentSignal } from "./shipment-signal";

const fresh = (): ShipmentSignal => ({ deliveredAt: null, carrierEta: null, via: [] });
const TODAY = "2026-11-09";

describe("trackingSuffix", () => {
    it("strips the encoded carrier prefix", () => {
        expect(trackingSuffix("UPS:::1ZH4D1120304690012")).toBe("1ZH4D1120304690012");
        expect(trackingSuffix("fedex:::383618912457")).toBe("383618912457");
    });

    it("keeps a bare number as-is", () => {
        expect(trackingSuffix("1551381344")).toBe("1551381344");
    });

    it("handles empty and null", () => {
        expect(trackingSuffix(null)).toBe("");
        expect(trackingSuffix("")).toBe("");
    });
});

describe("mergeSignal", () => {
    it("keeps the latest delivery across parcels", () => {
        const s = fresh();
        mergeSignal(s, { deliveredAt: "2026-11-02", today: TODAY });
        mergeSignal(s, { deliveredAt: "2026-11-05", today: TODAY });
        mergeSignal(s, { deliveredAt: "2026-11-02", today: TODAY });
        expect(s.deliveredAt).toBe("2026-11-05");
    });

    it("keeps the earliest live carrier ETA", () => {
        const s = fresh();
        mergeSignal(s, { carrierEta: "2026-11-14", today: TODAY });
        mergeSignal(s, { carrierEta: "2026-11-11", today: TODAY });
        expect(s.carrierEta).toBe("2026-11-11");
    });

    it("ignores a carrier ETA that is already past", () => {
        const s = fresh();
        mergeSignal(s, { carrierEta: "2026-10-30", today: TODAY });
        expect(s.carrierEta).toBeNull();
    });

    it("drops the carrier ETA once a delivery is known", () => {
        const s = fresh();
        mergeSignal(s, { carrierEta: "2026-11-12", today: TODAY });
        mergeSignal(s, { deliveredAt: "2026-11-10", today: TODAY });
        expect(s.deliveredAt).toBe("2026-11-10");
        expect(s.carrierEta).toBe("2026-11-12");
        // A later ETA must not replace the delivered state.
        mergeSignal(s, { carrierEta: "2026-11-20", today: TODAY });
        expect(s.carrierEta).toBe("2026-11-12");
    });

    it("records which stores contributed, once each", () => {
        const s = fresh();
        mergeSignal(s, { deliveredAt: "2026-11-05", via: ["po.tracking_numbers"], today: TODAY });
        mergeSignal(s, { deliveredAt: "2026-11-05", via: ["po.tracking_numbers", "po_shipment_legs"], today: TODAY });
        expect(s.via).toEqual(["po.tracking_numbers", "po_shipment_legs"]);
    });
});
