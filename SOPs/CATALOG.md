# BuildASoil SOP Catalog

## Current SOPs on the Hub (from DEFAULT_SOPS)

These are the SOPs that ship with the app. Those with a checkmark are written, others need writing.

### Purchasing (2 written, 5+ missing)
- [x] SOP How to Handle Out-of-Stock Procedure (draft)
- [x] Entering Receipts in Divvy Card App for Cardholders (draft)
- [ ] Purchase Order Creation and Approval ← **written in sops/purchasing/01**
- [ ] Vendor Receiving and Inspection ← **written in sops/purchasing/02**
- [ ] Finale Inventory Receiving ← **written in sops/purchasing/03**
- [ ] Vendor Contact and Reorder Points
- [ ] Discrepancy and Returns to Vendor

### Wholesale (4 written, 3 missing)
- [x] Wholesale Lead Intake and New Customer Onboarding (draft)
- [x] Wholesale Invoicing (active)
- [x] Wholesale Bulk Education Email (active)
- [x] Inbound Wholesale Form (active)
- [ ] Retention Outreach Calls
- [ ] Freight Order Support

### Customer Service (2 written, 6 missing)
- [x] Gorgias Ticket Handling Daily Workflow (draft)
- [x] Creating a Replacement Order in Shopify (active)
- [ ] FedEx Carrier Claims
- [ ] (4 more not listed)

### Parcel Shipping (2 written, 5 missing)
- [x] Pulling Boxes for Shipping Parcel (draft)
- [x] Shipping an Order Parcel (draft)
- [ ] ShipStation Daily Order Processing
- [ ] Parcel Packaging Standards
- [ ] (3 more not listed)

### Factory Outlet (1 written, 8 missing)
- [x] Walk-In Customer Orders & Local Pickup (active)
- [ ] Daily Open and Close Procedures
- [ ] (7 more not listed)

### Soil Products (3 written, 6 missing)
- [x] SOIL TEST (draft)
- [x] Manufacturing Mineral Kits (draft)
- [x] Green Machine Yards Build (draft)
- [ ] Soil Mix Batch Production
- [ ] Ingredient Weighing and Measuring
- [ ] (4 more not listed)

### Manufacturing (2 written, 6 missing)
- [x] Identifying and Printing Builds (draft)
- [x] Running MFG Build Report in Finale (draft)
- [ ] Small Product Batch Production Run
- [ ] Raw Material Pull and Staging
- [ ] (4 more not listed)

### Freight (1 written, 5 missing)
- [x] How to Pick and Pack Pallet Orders (draft)
- [ ] Freight Order Fulfillment
- [ ] FedEx Freight Booking Process
- [ ] (3 more not listed)

### Inventory (3 written, 5 missing)
- [x] Quick Stock Transfer in Finale (draft)
- [x] Reconciling SKUs in Finale (draft)
- [x] Receiving Purchase Order in Finale (draft)
- [ ] Daily Inventory Check and Cycle Count
- [ ] Receiving Inbound Shipments
- [ ] (3 more not listed)

### IT (0 written — restricted)
- [ ] New Employee System Access Setup
- [ ] System Outage and Escalation Protocol

### Operations (0 written — restricted)
- [ ] Payroll Processing
- [ ] Vendor Payment and AP

### Sales (0 written, 4 missing)
- [ ] Inbound Lead Qualification
- [ ] Dropship Account Setup

### Marketing (0 written, 5 missing)
- [ ] Gorgias AI Chatbot Quality Review
- [ ] Email Campaign SOP (Klaviyo)
- [ ] (3 more not listed)

---

## SOP Ideas for Purchasing

Beyond what's listed on the hub, these would complete Purchasing's coverage:

### High Priority
1. **Vendor Onboarding and Setup** — How to add a new vendor to Finale, set up payment terms, configure reorder points, and document contact info. Currently no SOP for this.
2. **Reorder Point Configuration** — How to calculate and set reorder points and max quantities in Finale based on velocity, lead time, and safety stock. The Aria reorder engine does this automatically, but a human-readable SOP explains the logic.
3. **AP Invoice Matching and Approval** — How invoices from vendors get matched to POs and receipts in Finale, who approves them, and how discrepancies are handled. Connects to the AP pipeline.
4. **Monthly/Weekly Purchasing Review** — Cadence for reviewing open POs, aging receipts, vendor performance, and reorder point adjustments.

### Medium Priority
5. **Freight PO Handling** — Creating POs specifically for freight charges, linking them to the originating PO, and handling landed costs.
6. **Rush/Expedite Order Process** — Steps for when a vendor needs to be contacted to expedite a delivery, including escalation path.
7. **Vendor Return / RMA Process** — How to initiate a return with a vendor, get an RMA number, arrange return shipping, and track credits.
8. **End-of-Month PO Reconciliation** — Closing out POs, reconciling receipts with invoices, and preparing AP data for month-end.

### Nice to Have
9. **Holiday/Vendor Shutdown Planning** — Ordering cadence adjustments around supplier closures.
10. **Prepayment and Deposit POs** — How to handle POs that require upfront payment.
11. **Drop-Ship Order Processing** — How drop-ship POs differ from standard POs in Finale.
12. **Material Substitution Process** — When a supplier can't fulfill with the exact SKU and offers a substitute.

---

## System: How to Edit and Publish

### File Structure
```
sops/
├── purchasing/
│   ├── 01-purchase-order-creation.md
│   ├── 02-vendor-receiving-inspection.md
│   ├── 03-finale-inventory-receiving.md
│   └── (add more here)
└── shared/           ← Aria internal HOWTOs, not for the hub
```

### Edit
1. Open any `.md` file in VS Code
2. Edit the YAML frontmatter (between `---` markers) for metadata
3. Edit the body for content
4. Save

### Publish
```
node scripts/sop-hub-publisher.js | clip
```
Then paste into the SOP Hub browser console.

### Add a New SOP
1. Create a new `.md` file in the appropriate department folder
2. Copy the frontmatter from an existing file
3. Write the content following the markdown format
4. Run the publisher
5. Paste into console
