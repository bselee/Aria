/**
 * @file    src/lib/obsidian/bridge.ts
 * @purpose Obsidian vault bridge — writes invoice summaries, scan/document notes,
 *          and vendor profiles into the vault. Provides a clean write API that
 *          the AP pipeline, scan ingestion, and cron jobs can call.
 * @author  Hermia
 * @created 2026-06-26
 * @deps    fs, path
 * @env     OBSIDIAN_VAULT_PATH — absolute path to the vault root
 */

import * as fs from "fs";
import * as path from "path";

// ── Vault path resolution ────────────────────────────────────────────────────

function resolveVaultPath(): string {
    const env = process.env.OBSIDIAN_VAULT_PATH;
    if (env && fs.existsSync(env)) return env;

    // Fallback: Windows default
    const winDefault = path.join(
        process.env.USERPROFILE || "C:\\Users\\BuildASoil",
        "Documents",
        "Obsidian Vault"
    );
    if (fs.existsSync(winDefault)) return winDefault;

    throw new Error(
        "Obsidian vault not found. Set OBSIDIAN_VAULT_PATH or ensure ~/Documents/Obsidian Vault exists."
    );
}

/** Ensure a subfolder exists in the vault, return its absolute path. */
function ensureFolder(name: string): string {
    const vault = resolveVaultPath();
    const dir = path.join(vault, name);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceSummary {
    vendorName: string;
    invoiceNumber: string;
    invoiceDate: string;       // ISO or YYYY-MM-DD
    dueDate?: string | null;
    poNumber?: string | null;
    total: number;
    subtotal?: number;
    freight?: number;
    tax?: number;
    status: string;            // received | reconciled | paid | disputed | void
    lineItemCount: number;
    source: string;            // email_attachment | portal_scrape | etc.
    reconciledAt?: string | null;
    notes?: string | null;
}

export interface ScanNote {
    fileName: string;
    filePath: string;          // original file path
    fileType: string;          // pdf | image | txt
    ocrText: string;
    extractedData?: Record<string, unknown>;
    ingestedAt: string;        // ISO timestamp
    source: string;            // scans | downloads | manual
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .substring(0, 60);
}

function formatDateForFilename(dateStr: string): string {
    try {
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toISOString().split("T")[0]; // YYYY-MM-DD
    } catch {
        return dateStr;
    }
}

function formatCurrency(amount: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
    }).format(amount);
}

function appendToFile(filePath: string, content: string): void {
    if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, "utf-8");
        fs.writeFileSync(filePath, existing + "\n\n" + content);
    } else {
        const frontmatter = `---\ntags: [invoices, ap, auto-sync]\ncreated: ${new Date().toISOString().split("T")[0]}\nupdated: ${new Date().toISOString().split("T")[0]}\n---\n\n`;
        fs.writeFileSync(filePath, frontmatter + content);
    }

    updateFrontmatterDate(filePath);
}

function updateFrontmatterDate(filePath: string): void {
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        const today = new Date().toISOString().split("T")[0];
        const updated = content.replace(
            /^updated:\s*\d{4}-\d{2}-\d{2}/m,
            `updated: ${today}`
        );
        if (updated !== content) {
            fs.writeFileSync(filePath, updated);
        }
    } catch {
        // Non-critical
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Write or append an invoice summary to the vault.
 *
 * Creates `Invoices/<vendor-slug>-<invoice-number>.md` with full invoice details,
 * and appends a one-line summary to `Vendors/<vendor-slug>.md` under a
 * "## Recent Invoices" section.
 *
 * @param invoice - The invoice summary to write
 * @returns Absolute path to the created/updated invoice note, or null on failure
 */
export function writeInvoiceSummary(invoice: InvoiceSummary): string | null {
    try {
        const vendorSlug = slugify(invoice.vendorName);
        const invoiceSlug = slugify(invoice.invoiceNumber || "unknown");
        const dateStr = formatDateForFilename(invoice.invoiceDate);

        const invoicesDir = ensureFolder("Invoices");
        const invoiceFile = path.join(
            invoicesDir,
            `${dateStr}-${vendorSlug}-${invoiceSlug}.md`
        );

        const lines: string[] = [
            `# Invoice: ${invoice.vendorName} #${invoice.invoiceNumber}`,
            ``,
            `| Field | Value |`,
            `|-------|-------|`,
            `| Vendor | ${invoice.vendorName} |`,
            `| Invoice # | ${invoice.invoiceNumber} |`,
            `| Date | ${invoice.invoiceDate} |`,
            `| Due Date | ${invoice.dueDate ?? "—"} |`,
            `| PO Number | ${invoice.poNumber ?? "—"} |`,
            `| Subtotal | ${formatCurrency(invoice.subtotal ?? 0)} |`,
            `| Freight | ${formatCurrency(invoice.freight ?? 0)} |`,
            `| Tax | ${formatCurrency(invoice.tax ?? 0)} |`,
            `| **Total** | **${formatCurrency(invoice.total)}** |`,
            `| Status | ${invoice.status} |`,
            `| Line Items | ${invoice.lineItemCount} |`,
            `| Source | ${invoice.source} |`,
            `| Reconciled | ${invoice.reconciledAt ?? "—"} |`,
        ];

        if (invoice.notes) {
            lines.push("", `## Notes`, "", invoice.notes);
        }

        lines.push(
            "",
            `## Links`,
            "",
            `- [[../Vendors/${invoice.vendorName}|Vendor: ${invoice.vendorName}]]`,
            invoice.poNumber
                ? `- PO: ${invoice.poNumber} (Finale)`
                : `- [[../SOPs/AP-Pipeline|AP Pipeline]]`,
            `- [[../SOPs/AP-Pipeline|AP Pipeline SOP]]`,
            "",
            `---`,
            `_Auto-synced from Aria AP pipeline at ${new Date().toISOString()}_`,
        );

        const frontmatter = `---\ntags: [invoice, ${vendorSlug}, ap, auto-sync]\ncreated: ${dateStr}\nupdated: ${new Date().toISOString().split("T")[0]}\n---\n\n`;
        fs.writeFileSync(invoiceFile, frontmatter + lines.join("\n") + "\n");

        // Append to vendor note
        const vendorsDir = ensureFolder("Vendors");
        const vendorFile = path.join(vendorsDir, `${invoice.vendorName}.md`);
        const summaryLine = `| ${invoice.invoiceDate} | #${invoice.invoiceNumber} | ${invoice.poNumber ?? "—"} | ${formatCurrency(invoice.total)} | ${invoice.status} | [[../Invoices/${dateStr}-${vendorSlug}-${invoiceSlug}|→]] |`;

        if (fs.existsSync(vendorFile)) {
            const existing = fs.readFileSync(vendorFile, "utf-8");
            if (existing.includes("## Recent Invoices")) {
                const updated = existing.replace(
                    /(\|\s*\*\*Total\*\*\s*\|\s*\*\*Status\*\*\s*\|\s*\*\*Link\*\*\s*\|)/,
                    `$1\n${summaryLine}`
                );
                if (updated !== existing) {
                    fs.writeFileSync(vendorFile, updated);
                } else {
                    const withRow = existing.replace(
                        /(## Recent Invoices\n)/,
                        `$1\n| Date | Invoice # | PO | Total | Status | Link |\n|------|-----------|-----|-------|--------|------|\n${summaryLine}\n`
                    );
                    fs.writeFileSync(vendorFile, withRow);
                }
            } else {
                const section = `\n\n## Recent Invoices\n\n| Date | Invoice # | PO | Total | Status | Link |\n|------|-----------|-----|-------|--------|------|\n${summaryLine}\n`;
                fs.writeFileSync(vendorFile, existing + section);
            }
            updateFrontmatterDate(vendorFile);
        }

        return invoiceFile;
    } catch (err: any) {
        console.error(`[obsidian-bridge] writeInvoiceSummary failed: ${err.message}`);
        return null;
    }
}

/**
 * Write a scan/document note to the vault.
 *
 * Creates `Scans/<slugified-filename>.md` with OCR text and extracted data.
 *
 * @param note - The scan note data
 * @returns Absolute path to the created note, or null on failure
 */
export function writeScanNote(note: ScanNote): string | null {
    try {
        const scansDir = ensureFolder("Scans");
        const fileSlug = slugify(note.fileName.replace(/\.[^.]+$/, ""));
        const dateStr = formatDateForFilename(note.ingestedAt);
        const noteFile = path.join(scansDir, `${dateStr}-${fileSlug}.md`);

        const lines: string[] = [
            `# Document: ${note.fileName}`,
            ``,
            `| Field | Value |`,
            `|-------|-------|`,
            `| File | ${note.fileName} |`,
            `| Type | ${note.fileType} |`,
            `| Source | ${note.source} |`,
            `| Ingested | ${note.ingestedAt} |`,
            `| Original Path | ${note.filePath} |`,
            ``,
            `## OCR Text`,
            ``,
            "```",
            note.ocrText.substring(0, 10000),
            "```",
        ];

        if (note.extractedData && Object.keys(note.extractedData).length > 0) {
            lines.push("", "## Extracted Data", "", "```json", JSON.stringify(note.extractedData, null, 2), "```");
        }

        lines.push(
            "",
            `## Links`,
            "",
            `- [[../SOPs/AP-Pipeline|AP Pipeline SOP]]`,
            `- [[../Aria/Home|Aria Home]]`,
            "",
            `---`,
            `_Auto-ingested from ${note.source} at ${note.ingestedAt}_`,
        );

        const frontmatter = `---\ntags: [scan, document, ${note.source}, auto-sync]\ncreated: ${dateStr}\nupdated: ${dateStr}\n---\n\n`;
        fs.writeFileSync(noteFile, frontmatter + lines.join("\n") + "\n");

        return noteFile;
    } catch (err: any) {
        console.error(`[obsidian-bridge] writeScanNote failed: ${err.message}`);
        return null;
    }
}

/**
 * Batch write multiple invoice summaries.
 * Useful for cron jobs that sync recent AP activity.
 *
 * @param invoices - Array of invoice summaries
 * @returns Object with succeeded/failed counts and file paths
 */
export function syncInvoiceBatch(
    invoices: InvoiceSummary[]
): { succeeded: number; failed: number; paths: string[] } {
    let succeeded = 0;
    let failed = 0;
    const paths: string[] = [];

    for (const inv of invoices) {
        const result = writeInvoiceSummary(inv);
        if (result) {
            succeeded++;
            paths.push(result);
        } else {
            failed++;
        }
    }

    return { succeeded, failed, paths };
}

/**
 * Read all vault notes and return them as structured data for Honcho sync.
 * Scans Invoices/, Vendors/, Scans/, SOPs/, and Aria/ folders.
 *
 * @param maxNotes - Maximum number of notes to return (default 100)
 * @returns Array of { path, title, content, tags }
 */
export function readVaultForSync(maxNotes: number = 100): Array<{
    path: string;
    title: string;
    content: string;
    tags: string[];
    updated: string;
}> {
    const vault = resolveVaultPath();
    const folders = ["Invoices", "Vendors", "Scans", "SOPs", "Aria", "Decisions"];
    const notes: Array<{
        path: string;
        title: string;
        content: string;
        tags: string[];
        updated: string;
    }> = [];

    for (const folder of folders) {
        const dir = path.join(vault, folder);
        if (!fs.existsSync(dir)) continue;

        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".md"));
        for (const file of files) {
            if (notes.length >= maxNotes) break;

            const fullPath = path.join(dir, file);
            const content = fs.readFileSync(fullPath, "utf-8");

            const titleMatch = content.match(/^#\s+(.+)$/m);
            const title = titleMatch ? titleMatch[1] : file.replace(/\.md$/, "");

            const tagsMatch = content.match(/^tags:\s*\[(.+?)\]/m);
            const tags = tagsMatch
                ? tagsMatch[1].split(",").map((t: string) => t.trim())
                : [];

            const updatedMatch = content.match(/^updated:\s*(.+)$/m);
            const updated = updatedMatch ? updatedMatch[1].trim() : "";

            notes.push({
                path: `${folder}/${file}`,
                title,
                content: content.substring(0, 5000),
                tags,
                updated,
            });
        }
    }

    return notes;
}
