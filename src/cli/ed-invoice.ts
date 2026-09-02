/**
 * @file    ed-invoice.ts
 * @purpose CLI: build a black-and-white Organic AG (Ed Zybura) invoice PDF.
 *          Invoice number is always the Finale PO number. Does not forward.
 * @author  Hermia
 * @created 2026-08-25
 * @deps    finale/client, pdf/ed-invoice
 * @env     FINALE_API_KEY, FINALE_API_SECRET, FINALE_ACCOUNT_PATH, FINALE_BASE_URL
 * @usage   node --env-file=.env.local --import tsx src/cli/ed-invoice.ts --po 125230 --freight 72.62 --tracking 1ZJ2Y7250304906559 --shipped 8-24-26
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { FinaleClient } from "../lib/finale/client";
import {
    buildEdInvoiceSpec,
    cents,
    renderEdInvoicePdf,
} from "../lib/pdf/ed-invoice";

interface CliArgs {
    po: string;
    freight: number;
    tracking: string | null;
    shipped: string | null;
    out: string | null;
    statedTotal: number | null;
}

function usage(): never {
    console.error(
        "Usage: node --env-file=.env.local --import tsx src/cli/ed-invoice.ts --po 125230 --freight 72.62 [--tracking 1Z…] [--shipped 8-24-26] [--total 1022.62] [--out path.pdf]"
    );
    process.exit(2);
}

function readFlag(argv: string[], name: string): string | null {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return null;
    const value = argv[idx + 1];
    if (!value || value.startsWith("--")) usage();
    return value;
}

/**
 * Parse CLI flags. --po and --freight are required.
 */
export function parseEdInvoiceArgs(argv: string[]): CliArgs {
    const po = readFlag(argv, "po");
    const freightRaw = readFlag(argv, "freight");
    if (!po || freightRaw == null) usage();
    const freight = Number(String(freightRaw).replace(/[$,]/g, ""));
    if (!Number.isFinite(freight)) usage();
    const totalRaw = readFlag(argv, "total");
    return {
        po,
        freight,
        tracking: readFlag(argv, "tracking"),
        shipped: readFlag(argv, "shipped"),
        out: readFlag(argv, "out"),
        statedTotal: totalRaw == null ? null : Number(String(totalRaw).replace(/[$,]/g, "")),
    };
}

async function main(): Promise<void> {
    const args = parseEdInvoiceArgs(process.argv.slice(2));
    const client = new FinaleClient();
    const summary = await client.getOrderSummary(args.po);
    if (!summary) {
        throw new Error(`Finale PO ${args.po} not found`);
    }

    const spec = buildEdInvoiceSpec({
        poNumber: summary.orderId || args.po,
        orderDate: summary.orderDate,
        items: summary.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            description: item.description,
        })),
        freight: args.freight,
        tracking: args.tracking,
        shipped: args.shipped,
    });

    if (args.statedTotal != null && cents(args.statedTotal) !== spec.total) {
        console.warn(
            `Stated total ${args.statedTotal} != computed ${spec.total} (subtotal ${spec.subtotal} + freight ${spec.freight}). Using computed.`
        );
    }

    const outPath =
        args.out ||
        join(homedir(), "Downloads", `Organic_AG_Invoice_${spec.invoiceNumber}.pdf`);
    renderEdInvoicePdf(spec, outPath);

    console.log(
        JSON.stringify(
            {
                pdf: outPath,
                invoiceNumber: spec.invoiceNumber,
                po: spec.poNumber,
                supplier: summary.supplier,
                lines: spec.lines,
                subtotal: spec.subtotal,
                freight: spec.freight,
                total: spec.total,
                tracking: spec.tracking,
                shipDate: spec.shipDate,
            },
            null,
            2
        )
    );
}

const isEntrypoint = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;
if (isEntrypoint) {
    main().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(message);
        process.exit(1);
    });
}
