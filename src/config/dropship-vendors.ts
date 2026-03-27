// DECISION(2026-02-27): These vendors always ship directly to customers —
// there is NEVER a matching Finale PO for them. Skip LLM classification and
// auto-route as DROPSHIP_INVOICE (forward to bill.com, no reconciliation).
// Add vendor name or email fragments (case-insensitive) as needed.
export const KNOWN_DROPSHIP_KEYWORDS = [
    "autopot",
    "logan labs",
    "loganlab",
    "evergreen growers",
    "evergreengrow",
    "abel",
    "abelsace",
    // add more: "vendor name fragment" or "emaildomain.com"
];
