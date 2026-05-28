/**
 * @file    src/lib/ordering/types.ts
 * @purpose Shared types for the browser-based vendor ordering system.
 *
 * @author  Hermia
 * @created 2026-05-28
 */

/** Line item as stored in purchase_orders.line_items JSONB */
export interface POLineItem {
    sku?: string;             // Finale internal SKU
    vendor_sku?: string;      // Vendor's item/part number (Uline: 1234, Axiom: SKU-...)
    description: string;
    quantity: number;
    unitPrice?: number;
    total?: number;
}

/** Supported vendor cart systems */
export type VendorPlatform = "uline" | "axiom" | "axiom_print";

/** Result of attempting to fill a vendor cart */
export interface CartFillResult {
    poNumber: string;
    vendor: VendorPlatform;
    itemsAttempted: number;
    itemsAdded: number;
    itemsFailed: Array<{ lineItem: POLineItem; reason: string }>;
    cartUrl: string;          // URL of the cart page for Bill to review
    screenshotPath?: string;  // Local path to cart screenshot
    error?: string;
}

/** Cookie file paths per vendor */
export const VENDOR_COOKIE_PATHS: Record<VendorPlatform, string> = {
    uline: "data/cookies/uline.json",
    axiom: "data/cookies/axiom.json",
    axiom_print: "data/cookies/axiom-print.json",
};

/** Vendor site URLs */
export const VENDOR_URLS: Record<VendorPlatform, { cart: string; search: string }> = {
    uline: {
        cart: "https://www.uline.com/ShoppingCart",
        search: "https://www.uline.com/Product/QuickSearch",
    },
    axiom: {
        cart: "https://www.axiomprint.com/shopping-cart",
        search: "https://www.axiomprint.com/catalog",
    },
    axiom_print: {
        cart: "https://www.axiomprint.com/shopping-cart",
        search: "https://www.axiomprint.com/catalog",
    },
};
