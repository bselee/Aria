/**
 * @file    src/cli/obsidian-verify-bridges.ts
 * @purpose End-to-end verification of all three Obsidian bridges.
 *          1. Tests writeInvoiceSummary() — creates a test invoice note
 *          2. Tests writeScanNote() — creates a test scan note
 *          3. Tests readVaultForSync() — reads back vault content
 *          4. Tests Honcho connectivity
 *
 * @author  Hermia
 * @created 2026-06-26
 */

import {
    writeInvoiceSummary,
    writeScanNote,
    readVaultForSync,
    type InvoiceSummary,
    type ScanNote,
} from "../lib/obsidian/bridge";

async function main() {
    console.log("=== Obsidian Bridge Verification ===\n");

    // ── 1. Test invoice summary bridge ──
    console.log("[1/4] Testing invoice summary bridge...");
    const testInvoice: InvoiceSummary = {
        vendorName: "Test Vendor Co",
        invoiceNumber: "TEST-001",
        invoiceDate: "2026-06-26",
        dueDate: "2026-07-26",
        poNumber: "PO-12345",
        total: 1234.56,
        subtotal: 1100.00,
        freight: 84.56,
        tax: 50.00,
        status: "received",
        lineItemCount: 3,
        source: "email_attachment",
        notes: "Verification test invoice — safe to delete.",
    };

    const invoiceResult = writeInvoiceSummary(testInvoice);
    if (invoiceResult) {
        console.log("  PASS: Invoice note created: " + invoiceResult);
    } else {
        console.log("  FAIL: Invoice note creation FAILED");
        process.exit(1);
    }

    // ── 2. Test scan note bridge ──
    console.log("\n[2/4] Testing scan note bridge...");
    const testScan: ScanNote = {
        fileName: "test-document.pdf",
        filePath: "C:\\Users\\BuildASoil\\Downloads\\test-document.pdf",
        fileType: "pdf",
        ocrText: "Test Document\n\nThis is a test OCR extraction.\nVendor: Test Vendor Co\nInvoice #: TEST-001\nTotal: $1,234.56",
        extractedData: {
            pageCount: 1,
            ocrStrategy: "test",
            hasImages: false,
        },
        ingestedAt: new Date().toISOString(),
        source: "verification-test",
    };

    const scanResult = writeScanNote(testScan);
    if (scanResult) {
        console.log("  PASS: Scan note created: " + scanResult);
    } else {
        console.log("  FAIL: Scan note creation FAILED");
        process.exit(1);
    }

    // ── 3. Test readVaultForSync ──
    console.log("\n[3/4] Testing vault read for Honcho sync...");
    const notes = readVaultForSync(100);
    console.log("  PASS: Read " + notes.length + " notes from vault");
    if (notes.length > 0) {
        console.log("  Sample notes:");
        for (const note of notes.slice(0, 5)) {
            console.log('    - ' + note.path + ': "' + note.title + '" [tags: ' + note.tags.join(", ") + ']');
        }
    }

    // ── 4. Test Honcho connectivity ──
    console.log("\n[4/4] Testing Honcho connectivity...");
    try {
        const resp = await fetch("http://127.0.0.1:8000/health");
        if (resp.ok) {
            const data = await resp.json();
            console.log("  PASS: Honcho healthy: " + JSON.stringify(data));
        } else {
            console.log("  WARN: Honcho returned " + resp.status);
        }
    } catch (err: any) {
        console.log("  FAIL: Honcho unreachable: " + err.message);
    }

    console.log("\n=== Verification Complete ===");
}

main().catch((err) => {
    console.error("Verification FAILED:", err);
    process.exit(1);
});
