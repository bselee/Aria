# Receipt Leg UOM Validation — 3 Sample POs (2026-08-12)

Task: P1 Finale receiving quantities → variance views (t_e00ea82c).
Risk register item: validate unit/UOM against Finale UI sample POs BEFORE the
auto-match engine consumes the receipt leg.

## Method

For each sample PO:
1. Pulled the PO from Finale via `getOrderSummary(orderId)` — this is the same
   REST document the Finale UI renders (supplier, order items, shipmentUrls).
2. Pulled each shipment detail via `getShipmentDetails(url)` and extracted the
   per-line receipt items (the physical-receipt record Finale shows on the
   shipment).
3. Cross-checked against `sku_pack_sizes` (case/bundle pack multipliers) to
   flag any unit-of-measure mismatch between ordered and received quantities.
4. Compared the values to what the sync wrote into PG `po_receipt_data`.

## Sample PO 125152 — Grassroots Fabric Pots (ORDER_COMPLETED)

| SKU     | Ordered | Received | UOM flag |
|---------|--------:|---------:|----------|
| GLP101  |      25 |       25 | none     |
| GLP113  |      10 |       10 | none     |
| GLP112  |      40 |       40 | none     |

Full receipt. ordered == received on every line. No pack-size flag
(SKU not in sku_pack_sizes with unitsPerPack > 1). PG row matches exactly:
total_ordered 75, total_received 75, units_short 0, fully_received true.

## Sample PO 125169 — Miles Filippelli (ORDER_LOCKED)

| SKU       | Ordered | Received | UOM flag |
|-----------|--------:|---------:|----------|
| BASLPE102 |      50 |       50 | none     |
| BASLPEE102|      50 |        0 | none     |

Partial receipt. BASLPE102 fully received; BASLPEE102 short 50. This is a REAL
short-ship signal, not a UOM artifact — both lines are the same SKU family in
the same unit basis. PG row matches: 100 ordered, 50 received, 50 short,
fully_received false.

## Sample PO 125170 — Sustainable Village (ORDER_LOCKED)

| SKU    | Ordered | Received | UOM flag |
|--------|--------:|---------:|----------|
| BLM221 |     200 |      100 | none     |
| BLM212 |     100 |        0 | none     |
| BLM206 |     300 |        0 | none     |
| ALK101 |     100 |        0 | none     |

Partial receipt. Only BLM221 partially received (100/200); three lines short.
PG row matches: 700 ordered, 100 received, 600 short, fully_received false.

## UOM findings

1. **No unit-of-measure mismatches found.** In all three samples, received
   quantities are on the same unit basis as ordered quantities. No line shows
   an over-receipt that would indicate case-vs-each confusion (the classic
   false-exception source the risk register flagged).
2. **No pack-size flags fired.** None of the sampled SKUs have a
   `sku_pack_sizes.units_per_pack > 1` entry that would require
   packMultiplier normalization in the three-way matcher. (For SKUs that DO
   have pack sizes, `pack-size-registry.getPackSizes()` is already wired into
   `po-lifecycle`'s gate and `receivings-enrichment`.)
3. **Date drift found and fixed:** a naive `new Date(rcv).toISOString()`
   shifted Finale's 18:00 local receipt timestamps into the NEXT UTC day
   (PO 125169 showed 2026-08-12 instead of Finale's 2026-08-11). The sync now
   extracts the YYYY-MM-DD prefix as-is (same guard as
   po-receipt-state.ts), so `last_receipt_date` matches the Finale UI display
   date exactly.
4. **Future-date guard:** Finale stores planned ETAs in `receiveDate` for
   committed POs (observed 2026-08-21 on a 2026-08-12 run, and 2026-10-31 on a
   July order). The sync only treats PAST dates as receipt evidence, so
   committed-but-not-yet-arrived POs do not pollute the variance/short-ship
   views with fake shorts.

## Verdict

Receipt leg is safe for the auto-match engine to consume. Quantities match the
Finale UI document 1:1, UOM is consistent on all sampled lines, and the two
data-quality guards (past-date only, date-prefix extraction) are in place.
