# 10 — Email Tracking & Ingest

**Domain:** Shipment & Order Monitoring  
**Owner:** aria-comms  
**Last Updated:** 2026-06-15

## Flow
- `email-tracking-ingest.ts` runs every 2 hours at :15
- `qty-recommender v2.6` enforces historical floor
- 3 tiers: standard_order_qty → auto-detect → lastPurchaseQty

---
**Status:** Ingest cadence documented.