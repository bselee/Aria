# 04 — Uline Autonomous Ordering (Detailed)

**Supersedes:** uline-cart-to-po

**Full Decision Tree**
1. Reorder engine flags need
2. Check if Uline cart already has items → ask Bill before proceeding
3. Always create Finale draft PO **before** pushing to cart
4. Unit conversion: eaches in Finale → cartons in Uline cart
5. Verify line items match after push
6. Notify Bill (payment/checkout remains manual)

**Technical Access**
- Product detail pages: qty + ADD button
- Cart: /Product/ViewCart
- B2B login required for checkout

**Related Skill:** `uline-autonomous-ordering` (replaces older flow)