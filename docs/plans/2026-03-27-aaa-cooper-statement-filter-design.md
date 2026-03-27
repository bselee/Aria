# AAA Cooper Statement Filter Design

**Problem**

AAA Cooper multi-invoice statement splitting is close, but the current per-page classifier is too permissive. Ancillary paperwork like BOLs, delivery receipts, and inspection notices can be misclassified as invoice pages and forwarded to Bill.com.

**Goal**

Keep the real invoice pages, discard the paperwork pages, and make the Telegram summary auditable at a glance.

**Approved Rules**

- A kept page must explicitly identify as `INVOICE`.
- A kept page must have a clearly identifiable billing number.
- For AAA Cooper, `PRO NUMBER` is an acceptable billing identifier.
- A kept page must contain billing fields such as charges, rate, due-date/billing details, shipping charges, or total.
- Pages that are shipment paperwork, inspection correction notices, delivery receipts, or BOL paperwork should be discarded even if they mention the same PRO number.

**Design**

Use vendor-specific post-filtering after the existing LLM per-page classification.

1. Keep the current page extraction and first-pass page classification.
2. Add an AAA Cooper-specific invoice-page validator that inspects the extracted page text.
3. A page only survives if both are true:
   - the LLM classified it as `INVOICE`
   - the page text passes the hard invoice checks above
4. Any rejected `INVOICE` pages are counted as discarded non-invoice paperwork.
5. Telegram summary reports both:
   - kept invoice count and list
   - discarded page count

**Why This Approach**

- It is safer than trying to make the generic prompt perfect.
- It keeps the existing working split flow intact.
- It gives AAA Cooper a stricter rule set without risking unrelated vendors.
- It produces a better operator-facing summary: `Split 3 invoice(s); discarded 5 non-invoice page(s)`.

**Non-Goals**

- No broad rewrite of the AP splitter.
- No attempt to infer missing invoice IDs.
- No vendor-agnostic “smart document understanding” pass beyond this targeted hardening.

**Testing**

- Unit tests for the AAA Cooper invoice-page validator.
- Integration-style test for statement split filtering:
  - invoice pages retained
  - BOL / delivery / inspection pages discarded
  - Telegram summary includes discarded-page count
