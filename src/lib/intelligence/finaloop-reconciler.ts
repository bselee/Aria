/**
 * @file    finaloop-reconciler.ts
 * @purpose Core engine for matching Finaloop Draft Orders against Daily Cash
 *          Report sheets from Google Drive. Computes cross-references and
 *          deposit-to-order matching suggestions (advisory only — no writes).
 * @author  Hermia
 * @created 2026-07-16
 * @deps    none (pure TypeScript)
 * @env     none
 */

/* ────────────────────────────── Types ────────────────────────────── */

/** Row from the Daily Cash Report Google Sheet */
export interface CashReportOrder {
  /** e.g. 6276730552420 */
  orderId: string;
  /** e.g. "#2569" */
  orderName: string;
  /** Transaction amount (e.g., 45.59) */
  amount: number;
}

/** Row from Finaloop Draft Orders CSV export */
export interface FinaloopDraftOrder {
  /** Date placed, e.g. "07/16/2026" */
  placedDate: string;
  /** Source e.g. "buildasoil-retail" */
  source: string;
  /** Sales channel e.g. "Draft Orders" */
  salesChannel: string;
  /** Order number e.g. "#2611" */
  order: string;
  /** Customer name */
  customer: string;
  /** Net sales amount */
  netSales: number;
  /** Net order amount */
  netOrder: number;
  /** Balance as of the export date */
  balanceAsOf: number;
  /** Current unpaid balance */
  currentBalance: number;
  /** Status string, e.g. "Fulfilled, Unpaid" */
  status: string;
  /** Payment method */
  payment: string;
}

/** Row from Finaloop Transactions CSV export (bank transactions) */
export interface FinaloopTransaction {
  /** Date of transaction, e.g. "07/10/2026" */
  date: string;
  /** Account type, e.g. "Bank" */
  accountType: string;
  /** Account name, e.g. "Bank of Colorado - Business Banking | Local Pass Through Checking | 7909" */
  account: string;
  /** Merchant name, e.g. "Unidentifiable Vendor" */
  merchant: string;
  /** Category, e.g. "Waiting for your input" */
  category: string;
  /** Transaction amount (positive = money in) */
  amount: number;
}

/** A pending bank deposit detected in the Transactions feed */
export interface PendingDeposit {
  date: string;
  account: string;
  merchant: string;
  amount: number;
}

/** Result of cross-referencing a sheet order against Finaloop data */
export interface OrderMatchStatus {
  orderName: string;
  /** Amount from the sheet */
  sheetAmount: number;
  /** Current unpaid balance in Finaloop (0 = already paid) */
  unpaidBalance: number;
  /** Customer name from Finaloop */
  customer: string;
  /** Whether this order is still unpaid and needs matching */
  isUnpaid: boolean;
  /** Placed date from Finaloop */
  placedDate: string;
  /** Fulfillment status */
  status: string;
}

/** Final output of the reconciliation engine */
export interface DepositMatchResult {
  /** Name/date of the cash report sheet */
  sheetLabel: string;
  /** Total amount from all orders in the sheet */
  sheetTotal: number;
  /** Orders found in the sheet */
  totalSheetOrders: number;

  /** Orders from the sheet that are still unpaid in Finaloop */
  unpaidOrders: OrderMatchStatus[];
  /** Sum of unpaid balances for orders from the sheet */
  unpaidTotal: number;

  /** Orders from the sheet that are already paid/zero balance */
  paidOrders: OrderMatchStatus[];
  /** Sum of already-paid amounts */
  paidTotal: number;

  /** Orders from the sheet not found in the Draft Orders export */
  notFoundInFinaloop: CashReportOrder[];
  /** Sum of amounts for orders not found */
  notFoundTotal: number;

  /** Deposit amount the user provided */
  depositAmount: number;
  /** Whether the deposit amount equals the unpaid total (perfect match) */
  depositMatchesUnpaid: boolean;
  /** Difference between deposit and unpaid total */
  depositVariance: number;
  /** Suggested match description */
  recommendation: string;
}

/* ───────────────────── Parsers ───────────────────── */

/**
 * Parse the Daily Cash Report CSV content exported from Google Sheets.
 * Expected columns: Order ID, Order name, Transaction amount, ...
 * Header row is skipped.
 */
export function parseCashReportCSV(csvContent: string): CashReportOrder[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  const orders: CashReportOrder[] = [];
  // Try to find header row — look for known column names
  const headerRowIndex = lines.findIndex(
    (l) =>
      l.toLowerCase().includes("order id") ||
      l.toLowerCase().includes("order name"),
  );

  if (headerRowIndex === -1) return [];

  const dataLines = lines.slice(headerRowIndex + 1);

  // Determine delimiter
  const delimiter = detectDelimiter(lines[headerRowIndex]);

  // Parse header to find column indices
  const headers = splitLine(lines[headerRowIndex], delimiter).map((h) =>
    h.toLowerCase().trim().replace(/^"|"$/g, ""),
  );

  const orderIdIdx = headers.findIndex(
    (h) => h === "order id" || h === "orderid",
  );
  const orderNameIdx = headers.findIndex(
    (h) => h === "order name" || h === "ordername" || h === "order",
  );
  const amountIdx = headers.findIndex(
    (h) =>
      h === "transaction amount" ||
      h === "transactionamo" ||
      h === "gross payments" ||
      h === "grosspayments" ||
      h === "amount",
  );

  if (orderNameIdx === -1 || amountIdx === -1) return [];

  for (const line of dataLines) {
    if (line.length === 0) continue;
    const cols = splitLine(line, delimiter);

    const orderName = cleanField(cols[orderNameIdx]);
    const amountStr = cleanField(
      amountIdx < cols.length ? cols[amountIdx] : "0",
    );

    if (!orderName || !amountStr) continue;

    const amount = parseMoney(amountStr);
    if (isNaN(amount)) continue;

    orders.push({
      orderId: orderIdIdx >= 0 && orderIdIdx < cols.length ? cleanField(cols[orderIdIdx]) : "",
      orderName,
      amount,
    });
  }

  return orders;
}

/**
 * Parse the Finaloop Draft Orders CSV export.
 * Handles the pipe-delimited format with quoted fields.
 */
export function parseFinaloopCSV(csvContent: string): FinaloopDraftOrder[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  // Find header row
  const headerRowIndex = lines.findIndex(
    (l) =>
      l.toLowerCase().includes("placed at") ||
      l.toLowerCase().includes("placed date") ||
      l.toLowerCase().includes("placedat"),
  );

  if (headerRowIndex === -1) return [];

  const delimiter = detectDelimiter(lines[headerRowIndex]);
  const headers = splitLine(lines[headerRowIndex], delimiter).map((h) =>
    h.toLowerCase().trim().replace(/^"|"$/g, ""),
  );

  const placedAtIdx = headers.findIndex(
    (h) => h === "placed at" || h === "placed date" || h === "placedat",
  );
  const sourceIdx = headers.findIndex((h) => h === "source");
  const salesChannelIdx = headers.findIndex(
    (h) => h === "sales channel" || h === "saleschannel",
  );
  const orderIdx = headers.findIndex((h) => h === "order");
  const customerIdx = headers.findIndex((h) => h === "customer");
  const netSalesIdx = headers.findIndex(
    (h) => h === "net sales" || h === "netsales",
  );
  const netOrderIdx = headers.findIndex(
    (h) => h === "net order" || h === "netorder",
  );
  const balanceAsOfIdx = headers.findIndex(
    (h) => h.includes("balance as of") || h.includes("balanceasof"),
  );
  const currentBalanceIdx = headers.findIndex(
    (h) => h === "current balance" || h === "currentbalance",
  );
  const statusIdx = headers.findIndex((h) => h === "status");
  const paymentIdx = headers.findIndex((h) => h === "payment");

  const orders: FinaloopDraftOrder[] = [];
  const dataLines = lines.slice(headerRowIndex + 1);

  for (const line of dataLines) {
    if (line.length === 0) continue;
    const cols = splitLine(line, delimiter);

    try {
      const order: FinaloopDraftOrder = {
        placedDate: placedAtIdx >= 0 ? cleanField(cols[placedAtIdx] || "") : "",
        source: sourceIdx >= 0 ? cleanField(cols[sourceIdx] || "") : "",
        salesChannel:
          salesChannelIdx >= 0 ? cleanField(cols[salesChannelIdx] || "") : "Draft Orders",
        order: orderIdx >= 0 ? cleanField(cols[orderIdx] || "") : "",
        customer: customerIdx >= 0 ? cleanField(cols[customerIdx] || "") : "",
        netSales: netSalesIdx >= 0 ? parseMoney(cleanField(cols[netSalesIdx] || "0")) : 0,
        netOrder: netOrderIdx >= 0 ? parseMoney(cleanField(cols[netOrderIdx] || "0")) : 0,
        balanceAsOf:
          balanceAsOfIdx >= 0 ? parseMoney(cleanField(cols[balanceAsOfIdx] || "0")) : 0,
        currentBalance:
          currentBalanceIdx >= 0
            ? parseMoney(cleanField(cols[currentBalanceIdx] || "0"))
            : 0,
        status: statusIdx >= 0 ? cleanField(cols[statusIdx] || "") : "",
        payment: paymentIdx >= 0 ? cleanField(cols[paymentIdx] || "") : "",
      };

      if (order.order) orders.push(order);
    } catch {
      // Skip malformed rows
    }
  }

  return orders;
}

/**
 * Parse the Finaloop Transactions CSV export.
 * Format: Date, Account type, Account, Merchant, Category, Amount
 * Handles both comma-delimited with quoted fields and pipe-delimited.
 */
export function parseTransactionsCSV(csvContent: string): FinaloopTransaction[] {
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  const headerRowIndex = lines.findIndex(
    (l) =>
      l.toLowerCase().includes("date") &&
      (l.toLowerCase().includes("merchant") || l.toLowerCase().includes("account type")),
  );

  if (headerRowIndex === -1) return [];

  const delimiter = detectDelimiter(lines[headerRowIndex]);
  const headers = splitLine(lines[headerRowIndex], delimiter).map((h) =>
    h.toLowerCase().trim().replace(/^"|"$/g, ""),
  );

  const dateIdx = headers.findIndex((h) => h === "date");
  const accountTypeIdx = headers.findIndex((h) => h === "account type" || h === "accounttype");
  const accountIdx = headers.findIndex((h) => h === "account");
  const merchantIdx = headers.findIndex((h) => h === "merchant");
  const categoryIdx = headers.findIndex((h) => h === "category");
  const amountIdx = headers.findIndex((h) => h === "amount");

  if (dateIdx === -1 || amountIdx === -1) return [];

  const transactions: FinaloopTransaction[] = [];
  const dataLines = lines.slice(headerRowIndex + 1);

  for (const line of dataLines) {
    if (line.length === 0) continue;
    const cols = splitLine(line, delimiter);

    try {
      const tx: FinaloopTransaction = {
        date: dateIdx < cols.length ? cleanField(cols[dateIdx]) : "",
        accountType: accountTypeIdx >= 0 && accountTypeIdx < cols.length ? cleanField(cols[accountTypeIdx]) : "",
        account: accountIdx >= 0 && accountIdx < cols.length ? cleanField(cols[accountIdx]) : "",
        merchant: merchantIdx >= 0 && merchantIdx < cols.length ? cleanField(cols[merchantIdx]) : "",
        category: categoryIdx >= 0 && categoryIdx < cols.length ? cleanField(cols[categoryIdx]) : "",
        amount: parseMoney(amountIdx < cols.length ? cols[amountIdx] : "0"),
      };

      if (tx.date && tx.amount !== 0) {
        transactions.push(tx);
      }
    } catch {
      // Skip malformed rows
    }
  }

  return transactions;
}

/**
 * Detect Bank of Colorado deposits that are pending categorization.
 * These are deposits with merchant "Unidentifiable Vendor" and
 * category "Waiting for your input" from Bank of Colorado accounts.
 */
export function detectPendingDeposits(transactions: FinaloopTransaction[]): PendingDeposit[] {
  return transactions
    .filter(
      (tx) =>
        (tx.account.toLowerCase().includes("bank of colorado") ||
         tx.account.toLowerCase().includes("colorado")) &&
        (tx.merchant.toLowerCase().includes("unidentifiable") ||
         tx.category.toLowerCase().includes("waiting for your input")) &&
        tx.amount > 0,
    )
    .map((tx) => ({
      date: tx.date,
      account: tx.account,
      merchant: tx.merchant,
      amount: tx.amount,
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/* ─────────────────── Cross-Reference Engine ─────────────────── */

/**
 * Cross-reference orders from the Daily Cash Report against Finaloop
 * Draft Orders to determine which are still unpaid.
 */
export function crossReferenceOrders(
  sheetOrders: CashReportOrder[],
  draftOrders: FinaloopDraftOrder[],
): {
  unpaid: OrderMatchStatus[];
  paid: OrderMatchStatus[];
  notFound: CashReportOrder[];
} {
  const unpaid: OrderMatchStatus[] = [];
  const paid: OrderMatchStatus[] = [];
  const notFound: CashReportOrder[] = [];

  // Build lookup: order name → Finaloop order
  const finaloopMap = new Map<string, FinaloopDraftOrder>();
  for (const o of draftOrders) {
    const key = o.order.trim().toLowerCase();
    // If duplicate order names, keep the one with higher balance
    const existing = finaloopMap.get(key);
    if (!existing || o.currentBalance > existing.currentBalance) {
      finaloopMap.set(key, o);
    }
  }

  for (const sheetOrder of sheetOrders) {
    const key = sheetOrder.orderName.trim().toLowerCase();
    const fo = finaloopMap.get(key);

    if (!fo) {
      notFound.push(sheetOrder);
      continue;
    }

    const status: OrderMatchStatus = {
      orderName: sheetOrder.orderName,
      sheetAmount: sheetOrder.amount,
      unpaidBalance: fo.currentBalance,
      customer: fo.customer,
      isUnpaid: fo.currentBalance > 0,
      placedDate: fo.placedDate,
      status: fo.status,
    };

    if (fo.currentBalance > 0) {
      unpaid.push(status);
    } else {
      paid.push(status);
    }
  }

  return { unpaid, paid, notFound };
}

/**
 * Given a deposit amount and a list of unpaid orders, compute the
 * best matching suggestion.
 */
export function computeDepositCoverage(
  depositAmount: number,
  unpaidOrders: OrderMatchStatus[],
): {
  /** Subset of orders that best match the deposit */
  matchedOrders: OrderMatchStatus[];
  matchedTotal: number;
  remainingDeposit: number;
  /** Orders not included in the match */
  unmatchedOrders: OrderMatchStatus[];
  unmatchedTotal: number;
  isExactMatch: boolean;
} {
  // Sort by amount descending for greedy approach
  const sorted = [...unpaidOrders].sort((a, b) => b.unpaidBalance - a.unpaidBalance);

  // Greedy subset-sum: pick largest orders that fit
  const matched: OrderMatchStatus[] = [];
  let remaining = depositAmount;
  const unmatched: OrderMatchStatus[] = [];

  for (const order of sorted) {
    if (order.unpaidBalance <= remaining + 0.01) {
      // Allow 1¢ tolerance
      matched.push(order);
      remaining -= order.unpaidBalance;
    } else {
      unmatched.push(order);
    }
  }

  // Round to avoid floating-point artifacts
  remaining = Math.round(remaining * 100) / 100;
  const matchedTotal = Math.round(
    matched.reduce((s, o) => s + o.unpaidBalance, 0) * 100,
  ) / 100;
  const unmatchedTotal =
    Math.round(unpaidOrders.reduce((s, o) => s + o.unpaidBalance, 0) * 100) / 100 -
    matchedTotal;

  return {
    matchedOrders: matched,
    matchedTotal,
    remainingDeposit: remaining,
    unmatchedOrders: unmatched,
    unmatchedTotal,
    isExactMatch: Math.abs(remaining) < 0.02,
  };
}

/**
 * Result of matching all pending deposits against a set of unpaid orders.
 */
export interface MultiDepositMatchResult {
  /** All pending deposits found */
  deposits: PendingDeposit[];
  /** Sheet info */
  sheetLabel: string;
  /** Unpaid orders from the sheet (available for matching) */
  unpaidOrders: OrderMatchStatus[];
  unpaidTotal: number;
  /** Per-deposit matching suggestions */
  matches: DepositMatchSuggestion[];
  /** Summary text */
  summary: string;
}

/** A suggested match between one deposit and a subset of orders */
export interface DepositMatchSuggestion {
  deposit: PendingDeposit;
  /** Date window used for filtering (e.g., "06/19 - 07/10" for a Jul 10 deposit) */
  dateWindow: string;
  /** Orders within the date window that are unpaid */
  windowOrders: OrderMatchStatus[];
  windowTotal: number;
  /** Orders within the date window that were greedily matched to the deposit */
  matchedOrders: OrderMatchStatus[];
  matchedTotal: number;
  remainingFromDeposit: number;
  isExactMatch: boolean;
  /** Whether this deposit likely covers these orders */
  confidence: "high" | "medium" | "low";
}

/**
 * Match multiple pending deposits against unpaid orders using date proximity.
 * For each deposit, only orders placed within ~3 weeks before the deposit
 * date are considered. This naturally correlates deposits to their
 * corresponding sales periods without needing explicit period data.
 */
export function reconcileMultipleDeposits(
  sheetCSV: string,
  finaloopCSV: string,
  transactionsCSV: string,
  sheetLabel: string = "Daily Cash Report",
  dateWindowDays: number = 21,
): MultiDepositMatchResult {
  const sheetOrders = parseCashReportCSV(sheetCSV);

  const allFinaloopOrders = parseFinaloopCSV(finaloopCSV);
  const draftOrders = allFinaloopOrders.filter(
    (o) =>
      o.salesChannel.toLowerCase().includes("draft") ||
      o.salesChannel.toLowerCase().includes("manual"),
  );
  const ordersToUse = draftOrders.length > 0 ? draftOrders : allFinaloopOrders;

  const { unpaid, notFound } = crossReferenceOrders(sheetOrders, ordersToUse);

  // Detect pending deposits from transactions
  const allTransactions = parseTransactionsCSV(transactionsCSV);
  const pendingDeposits = detectPendingDeposits(allTransactions);

  // Sort deposits oldest-first
  const sortedDeposits = [...pendingDeposits].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const matches: DepositMatchSuggestion[] = [];

  for (const deposit of sortedDeposits) {
    const windowStart = daysBefore(deposit.date, dateWindowDays);

    // Filter unpaid orders to those placed within the date window
    // Include a few days after deposit (some orders close to the deposit may be batched)
    const windowEndDate = parseDate(deposit.date);
    if (windowEndDate) windowEndDate.setDate(windowEndDate.getDate() + 3); // 3 days grace

    const windowOrders = unpaid.filter((o) => {
      const orderDate = parseDate(o.placedDate);
      if (!orderDate || !windowEndDate) return false;
      const windowStartDate = parseDate(windowStart);
      if (!windowStartDate) return false;
      // Order date should be between window start and deposit date + 3 days
      return orderDate >= windowStartDate && orderDate <= windowEndDate;
    });

    // Sort by amount descending for greedy matching
    const sorted = [...windowOrders].sort(
      (a, b) => b.unpaidBalance - a.unpaidBalance,
    );

    const matched: OrderMatchStatus[] = [];
    let remaining = deposit.amount;

    for (const order of sorted) {
      if (order.unpaidBalance <= remaining + 0.01) {
        matched.push(order);
        remaining -= order.unpaidBalance;
      }
    }

    remaining = Math.round(remaining * 100) / 100;
    const matchedTotal = Math.round(matched.reduce((s, o) => s + o.unpaidBalance, 0) * 100) / 100;
    const windowTotal = Math.round(windowOrders.reduce((s, o) => s + o.unpaidBalance, 0) * 100) / 100;
    const isExactMatch = Math.abs(remaining) < 0.02;

    // Determine confidence based on how well the deposit covers the window
    let confidence: "high" | "medium" | "low" = "low";
    if (isExactMatch && matched.length > 0) {
      confidence = "high";
    } else if (windowOrders.length > 0 && Math.abs(remaining) < windowTotal * 0.05) {
      // Within 5% of the window total (accounts for fees)
      confidence = "medium";
    } else if (matched.length > 0 && remaining < deposit.amount * 0.1) {
      confidence = "medium";
    }

    matches.push({
      deposit,
      dateWindow: `${windowStart} - ${deposit.date}`,
      windowOrders,
      windowTotal,
      matchedOrders: matched,
      matchedTotal,
      remainingFromDeposit: remaining,
      isExactMatch,
      confidence,
    });
  }

  // Build summary
  const summaryParts: string[] = [];
  const totalDeposits = sortedDeposits.reduce((s, d) => s + d.amount, 0);
  const unpaidTotal = Math.round(unpaid.reduce((s, o) => s + o.unpaidBalance, 0) * 100) / 100;

  if (pendingDeposits.length === 0) {
    summaryParts.push("No pending Bank of Colorado deposits found in Transactions export.");
  } else {
    summaryParts.push(
      `Found ${pendingDeposits.length} pending deposit(s) totaling $${totalDeposits.toFixed(2)}.`,
    );
  }

  if (unpaid.length > 0) {
    summaryParts.push(
      `${unpaid.length} unpaid Draft Order(s) from sheet available ($${unpaidTotal.toFixed(2)}).`,
    );
  }

  const highConfidence = matches.filter((m) => m.confidence === "high" && m.matchedOrders.length > 0);
  if (highConfidence.length > 0) {
    summaryParts.push(
      `${highConfidence.length} deposit(s) have exact matches.`,
    );
  }

  return {
    deposits: pendingDeposits,
    sheetLabel,
    unpaidOrders: unpaid,
    unpaidTotal,
    matches,
    summary: summaryParts.join(" "),
  };
}

/**
 * Full reconciliation: parse sheet CSV + Finaloop CSV, cross-reference,
 * compute deposit coverage, return a structured result.
 */
export function reconcileDeposit(
  sheetCSV: string,
  finaloopCSV: string,
  depositAmount: number,
  sheetLabel: string = "Daily Cash Report",
): DepositMatchResult {
  const sheetOrders = parseCashReportCSV(sheetCSV);

  // Draft Orders filter: only Draft Orders from Finaloop CSV
  const allFinaloopOrders = parseFinaloopCSV(finaloopCSV);
  const draftOrders = allFinaloopOrders.filter(
    (o) =>
      o.salesChannel.toLowerCase().includes("draft") ||
      o.salesChannel.toLowerCase().includes("manual"),
  );

  // If no Draft Orders found, try using all orders
  const ordersToUse = draftOrders.length > 0 ? draftOrders : allFinaloopOrders;

  const { unpaid, paid, notFound } = crossReferenceOrders(sheetOrders, ordersToUse);

  const sheetTotal = Math.round(
    sheetOrders.reduce((s, o) => s + o.amount, 0) * 100,
  ) / 100;
  const unpaidTotal =
    Math.round(unpaid.reduce((s, o) => s + o.unpaidBalance, 0) * 100) / 100;
  const paidTotal =
    Math.round(paid.reduce((s, o) => s + o.sheetAmount, 0) * 100) / 100;
  const notFoundTotal = Math.round(
    notFound.reduce((s, o) => s + o.amount, 0) * 100,
  ) / 100;

  const depositVariance = Math.round((depositAmount - unpaidTotal) * 100) / 100;
  const depositMatchesUnpaid = Math.abs(depositVariance) < 0.02;

  // Generate recommendation text
  const recParts: string[] = [];

  if (unpaid.length === 0) {
    recParts.push(
      "✅ All orders from this sheet are already matched in Finaloop.",
    );
  } else if (depositMatchesUnpaid) {
    recParts.push(
      `✅ Deposit of $${depositAmount.toFixed(2)} exactly matches ` +
        `${unpaid.length} unpaid Draft Order(s) from this period ($${unpaidTotal.toFixed(2)}).`,
    );
    recParts.push(
      `→ Match these ${unpaid.length} orders to the deposit in Finaloop.`,
    );
  } else if (depositAmount > unpaidTotal) {
    recParts.push(
      `Deposit of $${depositAmount.toFixed(2)} exceeds unpaid sheet orders ` +
        `by $${depositVariance.toFixed(2)}.`,
    );
    recParts.push(
      `→ Match the ${unpaid.length} unpaid orders ($${unpaidTotal.toFixed(2)}) ` +
        `and investigate the extra $${depositVariance.toFixed(2)}.`,
    );
  } else {
    recParts.push(
      `Deposit of $${depositAmount.toFixed(2)} is less than unpaid sheet orders ` +
        `by $${Math.abs(depositVariance).toFixed(2)}.`,
    );
    recParts.push(
      `→ The deposit likely covers a subset of orders. See matched subset below.`,
    );
  }

  if (notFound.length > 0) {
    recParts.push(
      `ℹ️ ${notFound.length} order(s) from the sheet ($${notFoundTotal.toFixed(2)}) ` +
        `were not found in Draft Orders — likely paid via digital processor.`,
    );
  }

  return {
    sheetLabel,
    sheetTotal,
    totalSheetOrders: sheetOrders.length,
    unpaidOrders: unpaid,
    unpaidTotal,
    paidOrders: paid,
    paidTotal,
    notFoundInFinaloop: notFound,
    notFoundTotal,
    depositAmount,
    depositMatchesUnpaid,
    depositVariance,
    recommendation: recParts.join("\n"),
  };
}

/* ─────────────────── Internal Helpers ─────────────────── */

function detectDelimiter(line: string): string {
  // Check for pipe first (Finaloop uses pipes)
  const pipeCount = (line.match(/\|/g) || []).length;
  const commaCount = (line.match(/,/g) || []).length;
  const tabCount = (line.match(/\t/g) || []).length;

  if (pipeCount >= commaCount && pipeCount >= tabCount && pipeCount > 0)
    return "|";
  if (tabCount >= pipeCount && tabCount > 0) return "\t";
  return ",";
}

function splitLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function cleanField(field: string): string {
  return field.replace(/^"|"$/g, "").trim();
}

function parseMoney(str: string): number {
  const cleaned = str.replace(/[$,]/g, "").trim();
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : Math.round(val * 100) / 100;
}

/**
 * Parse a date string in MM/DD/YYYY or M/D/YYYY format to a Date object.
 * Returns null if invalid.
 */
function parseDate(str: string): Date | null {
  if (!str) return null;
  const parts = str.split("/");
  if (parts.length !== 3) return null;
  const month = parseInt(parts[0], 10) - 1;
  const day = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (isNaN(month) || isNaN(day) || isNaN(year)) return null;
  const d = new Date(year, month, day);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Get a date N days before a given date string.
 * Returns formatted as MM/DD/YYYY.
 */
function daysBefore(dateStr: string, days: number): string {
  const d = parseDate(dateStr);
  if (!d) return dateStr;
  d.setDate(d.getDate() - days);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${m}/${day}/${d.getFullYear()}`;
}
