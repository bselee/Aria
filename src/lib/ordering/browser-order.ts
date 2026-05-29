/**
 * @file    src/lib/ordering/browser-order.ts
 * @purpose Orchestrates browser-based vendor ordering. Loads a committed PO,
 *          connects to Chrome, fills the vendor cart, screenshots it, and
 *          sends a Telegram message with review/approve/abandon buttons.
 *
 * @author  Hermia
 * @created 2026-05-28
 * @deps    BrowserManager, vendor cart fillers, Supabase, telegram-notify
 *
 * FLOW:
 *   1. Load PO + line items from Supabase
 *   2. Detect vendor platform from vendor_name
 *   3. Launch headful Chrome (so Bill can watch)
 *   4. Load saved cookies
 *   5. Fill vendor cart with PO items
 *   6. Screenshot cart
 *   7. Send Telegram: cart summary + [✅ Approve] [❌ Abandon] buttons
 *   8. Log to ap_activity_log
 *
 * SAFETY:
 *   - Never auto-submits payment. Always stops at cart.
 *   - Uses headful mode so Bill can intervene at any time.
 *   - Saves cookies after login for session reuse.
 */

import { createClient } from "@/lib/supabase";
import { sendTelegramNotifyWithButtons } from "@/lib/intelligence/telegram-notify";
import { BrowserManager } from "@/lib/scraping/browser-manager";
import { fillUlineCart } from "./uline-cart";
import { fillAxiomCart } from "./axiom-cart";
import type { VendorPlatform, CartFillResult, POLineItem, } from "./types";
import { VENDOR_COOKIE_PATHS } from "./types";

/** Map vendor_name patterns to platform */
function detectVendorPlatform(vendorName: string): VendorPlatform | null {
    const name = vendorName.toLowerCase();
    if (name.includes("uline") || name.includes("u-line")) return "uline";
    if (name.includes("axiom") && name.includes("print")) return "axiom_print";
    if (name.includes("axiom")) return "axiom";
    return null;
}

/**
 * Execute a browser-based order for a committed PO.
 * Called from Telegram /order command or dashboard.
 */
export async function executeBrowserOrder(poNumber: string): Promise<CartFillResult | null> {
    const supabase = createClient();
    if (!supabase) {
        console.error("[browser-order] Supabase not available");
        return null;
    }

    // 1. Load PO
    const { data: po, error: poError } = await supabase
        .from("purchase_orders")
        .select("po_number, vendor_name, vendor_party_id, line_items, completion_state, total_amount, status")
        .eq("po_number", poNumber)
        .single();

    if (poError || !po) {
        await sendTelegramNotifyWithButtons(
            `❌ *Order Failed*\nPO ${poNumber} not found in database.`,
            []
        );
        return null;
    }

    const vendorName = po.vendor_name || "Unknown";
    const platform = detectVendorPlatform(vendorName);

    if (!platform) {
        await sendTelegramNotifyWithButtons(
            `❌ *Unsupported Vendor*\n${vendorName} — no browser ordering flow configured.\n\nSupported: Uline, Axiom`,
            []
        );
        return null;
    }

    // 2. Parse line items
    const lineItems: POLineItem[] = Array.isArray(po.line_items) ? po.line_items : [];
    if (lineItems.length === 0) {
        await sendTelegramNotifyWithButtons(
            `⚠️ *PO ${poNumber} has no line items.*\n\nNothing to add to ${vendorName} cart.`,
            []
        );
        return null;
    }

    // 3. Notify Bill we're starting
    await sendTelegramNotifyWithButtons(
        `🛒 *Starting ${vendorName} order*\nPO ${poNumber} — ${lineItems.length} item(s)\n\nOpening browser...`,
        []
    );

    // 4. Launch browser (headful so Bill can watch)
    const browserManager = BrowserManager.getInstance();
    const cookiesPath = VENDOR_COOKIE_PATHS[platform];
    let page;

    try {
        page = await browserManager.launchBrowser({
            headless: false,  // CRITICAL: Bill needs to see this
            cookiesPath,
            useRunningBrowser: true, // Prefer existing Chrome via CDP
            useBrowserbase: process.env.BROWSERBASE_AUTO === 'true', // KAIZEN: cloud browser if enabled
            browserbaseTaskType: `cart-filling-${platform}`, // Session reuse within vendor
        });
    } catch (err: any) {
        await sendTelegramNotifyWithButtons(
            `❌ *Browser launch failed*\n${err.message}\n\nMake sure Chrome is running with --remote-debugging-port=9222`,
            []
        );
        return null;
    }

    // 5. Fill cart using vendor-specific logic
    let result: CartFillResult;

    try {
        switch (platform) {
            case "uline":
                result = await fillUlineCart(page, poNumber, lineItems);
                break;
            case "axiom":
            case "axiom_print":
                result = await fillAxiomCart(page, poNumber, lineItems);
                break;
            default:
                throw new Error(`Unknown platform: ${platform}`);
        }
    } catch (err: any) {
        result = {
            poNumber,
            vendor: platform,
            itemsAttempted: lineItems.length,
            itemsAdded: 0,
            itemsFailed: lineItems.map(i => ({ lineItem: i, reason: err.message })),
            cartUrl: "",
            error: err.message,
        };
    }

    // 6. Send Telegram result with action buttons
    const lines: string[] = [];
    lines.push(`🛒 *${vendorName} Cart Ready*`);
    lines.push(`PO ${poNumber} · ${result.itemsAdded}/${result.itemsAttempted} items added`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (result.itemsAdded > 0) {
        lines.push(`\n✅ *Added: ${result.itemsAdded} item(s)*`);
    }

    if (result.itemsFailed.length > 0) {
        lines.push(`\n❌ *Failed (${result.itemsFailed.length}):*`);
        for (const f of result.itemsFailed.slice(0, 5)) {
            lines.push(`  • ${f.lineItem.description} — ${f.reason}`);
        }
        if (result.itemsFailed.length > 5) {
            lines.push(`  ... and ${result.itemsFailed.length - 5} more`);
        }
    }

    if (result.error) {
        lines.push(`\n⚠️ ${result.error}`);
    }

    if (result.screenshotPath) {
        lines.push(`\n📸 Screenshot: ${result.screenshotPath}`);
    }

    lines.push(`\n🔗 Cart: ${result.cartUrl}`);

    const buttons = result.itemsAdded > 0 ? [
        [
            { text: "✅ Cart looks good — proceed", callback_data: `order_approve_${poNumber}` },
            { text: "❌ Abandon", callback_data: `order_abandon_${poNumber}` },
        ],
    ] : [];

    await sendTelegramNotifyWithButtons(lines.join("\n"), buttons);

    // 7. Log to ap_activity_log
    try {
        await supabase.from("ap_activity_log").insert({
            email_from: "browser-order",
            email_subject: `Browser order: PO ${poNumber} → ${vendorName}`,
            intent: "BROWSER_ORDER",
            action_taken: `Added ${result.itemsAdded}/${result.itemsAttempted} items to ${vendorName} cart`,
            metadata: {
                poNumber,
                vendorName,
                platform,
                itemsAdded: result.itemsAdded,
                itemsAttempted: result.itemsAttempted,
                itemsFailed: result.itemsFailed.length,
                cartUrl: result.cartUrl,
                screenshotPath: result.screenshotPath,
                orderedAt: new Date().toISOString(),
            },
        });
    } catch { /* non-blocking */ }

    // 8. Save cookies for future sessions
    try {
        await browserManager.saveCookies();
    } catch { /* non-critical */ }

    return result;
}
