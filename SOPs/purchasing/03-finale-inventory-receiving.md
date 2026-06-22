---
title: Finale Inventory Receiving
status: draft
department: Purchasing
usedBy:
  - Inventory
access: public
owner: "Responsible Role: Receiving or Inventory Staff"
platforms:
  - Finale Inventory
category: Receiving
reviewDate: "Sep 22, 2026"
---

## Purpose
Receive purchase order items into Finale Inventory so stock quantities are updated, costs are recorded, and the PO moves to Completed status.

## When to Use
After physical inspection of a vendor shipment is complete and items are ready to be added to system inventory.

## Risk if Not Followed
Inventory counts stay incorrect, AP cannot close the PO, supplier invoices fail to match, and reorder recommendations are based on wrong stock levels.

## Sections

### Open the Purchase Order
1. Log in to Finale Inventory.
2. Navigate to Purchasing > View Purchase Orders.
3. Search for the PO number from the packing slip or use the supplier filter to locate the order.
4. Click the PO to open its detail view.
5. Confirm the PO status is Committed — if it is Draft, do not receive against it. Contact Purchasing.

### Receive Items Against the PO
1. Click Receive Purchase Order at the top of the PO detail screen.
2. Select the correct warehouse location where the items are physically staged.
3. For each line item on the PO: enter the quantity actually received (not the ordered quantity if there was a shortage).
4. If the item has lot tracking or expiration dates: click into the lot fields and enter the lot number and date from the packaging.
5. Assign the items to the correct sublocation within the warehouse (e.g., Ship-0, Bulk-1, MFG-Raw).
6. If any items on the PO are not yet received (partial shipment): leave their received quantity at zero. They can be received later when the rest arrives.

### Apply Landed Costs (If Applicable)
1. If the supplier added freight, handling, or other charges to the invoice: click Add Landed Cost on the receive screen.
2. Select the cost type (Freight, Handling, Duty, Other).
3. Enter the dollar amount. Finale will distribute it across the received items proportionally.
4. Do not add estimated costs — only enter amounts confirmed on the invoice or packing slip.

### Complete the Receipt
1. Review the receive summary: quantities, location, sublocation, and landed costs.
2. Click Complete Shipment or Save to finalize the receipt in Finale.
3. Confirm the PO status updates to Partially Received (if more items are coming) or Completed (if fully received).
4. If the PO shows Completed but more items are expected: contact Purchasing to reopen or create a follow-up PO for the balance.
5. Exit to the PO list and verify the system inventory count for a sample item has updated correctly.

### Final Steps
1. Write the Finale receipt confirmation number or PO status on the packing slip and file it in the receiving binder or shared drive.
2. If the received items include time-sensitive or customer-committed stock: notify the Fulfillment or Sales team via Slack.
3. If there was a quantity discrepancy: ensure Purchasing and AP have the documented shortage for their records.
4. Move the staged items to their permanent storage locations now that inventory is live in the system.

## Quality
- Items are received in Finale within 4 hours of physical arrival.
- Received quantities match the physically counted quantities — never receive the PO qty if the count was short.
- Sublocations are set correctly so inventory is findable for picking and builds.
- Landed costs are applied when the supplier invoice includes freight or handling.
- Packing slips are filed and cross-referenced to the PO for audit trail.

## Cross-Department
- AP matches the Finale receipt to supplier invoices for payment — incomplete or incorrect receiving delays vendor payments.
- Manufacturing relies on accurate raw material counts for production planning — receiving delays stall builds.

## Related SOPs
- SOP - Vendor Receiving and Inspection (complete this first)
- SOP - Purchase Order Creation and Approval

## Troubleshooting
- PO shows wrong location: Do not receive. Contact Purchasing to correct the PO location before proceeding.
- Cannot find the correct sublocation: Use General as a temporary location, then contact Inventory to set up the correct sublocation after receiving.
- System shows item already received but it is not physically here: Stop — this indicates a prior receiving error. Contact Purchasing and Inventory to investigate before double-receiving.
- Supplier sent items not on the PO: Do not receive into Finale. Contact Purchasing for a new PO or return authorization.
