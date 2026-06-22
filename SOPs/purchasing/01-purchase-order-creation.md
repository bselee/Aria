---
title: Purchase Order Creation and Approval
status: draft
department: Purchasing
usedBy:
  - Inventory
access: public
owner: "Responsible Role: Purchasing Staff"
platforms:
  - Finale Inventory
  - Gmail
category: Procurement
reviewDate: "Sep 22, 2026"
---

## Purpose
Create and approve purchase orders in Finale Inventory to replenish stock and maintain accurate inventory levels across all locations.

## When to Use
Whenever stock falls below the reorder point, a new item needs to be introduced, or a supplier requests a PO to process an order.

## Risk if Not Followed
Orders are placed with incorrect quantities or pricing, inventory goes out of stock, duplicate orders are created, or payment terms are missed.

## Sections

### Identify What to Order
1. Open Finale Inventory Stock > Reorder to review items flagged for restock.
2. Review the Quantity to Order column.
3. Check Current Stock sorted by Remaining Quantity ascending.
4. Cross-reference with open customer orders and production builds.
5. Check supplier minimum order quantity and shipping schedule.

### Select Supplier and Get Pricing
1. Confirm preferred supplier on product detail page.
2. Check last PO or email for current pricing. If unclear, request quote.
3. For recurring orders, use last confirmed price.
4. Note lead time and delivery window.

### Create the PO in Finale
1. Navigate to Purchasing > New Purchase Order.
2. Select supplier, warehouse location, order date, expected date.
3. Add items by SKU with quantity and unit price.
4. Review subtotal. Set status to Draft.

### Review and Approve
1. Verify quantities, prices, supplier, location, date.
2. Under $500: self-approve and commit.
3. $500+: send to Ops Manager in Slack for review.
4. Once approved: click Commit. Email PO as PDF to supplier.

### Communicate the Order
1. Add note in Finale with supplier details.
2. If out-of-stock: post PO number and ETA in Slack thread.

## Quality
- Confirmed price and supplier before committing.
- Approval documented for POs over $500.
- Lead time recorded for tracking.

## Cross-Department
- Notify Inventory of urgent POs via Slack.
- AP uses PO data for invoice matching.

## Related SOPs
- SOP How to Research Purchase Orders in Finale Inventory
- SOP - Vendor Receiving and Inspection
- SOP - Finale Inventory Receiving

## Troubleshooting
- Supplier wont accept email POs: Use their web portal or call. Note the portal reference in Finale.
- Price differs from last PO: Email supplier for a current quote before committing.
- PO needs cancellation: Open PO, click Cancel. Notify supplier, update Slack thread.
- Supplier never received PO: Resend from Finale as PDF. Confirm correct email on file.
