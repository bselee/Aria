/**
 * @file    aria-review-watcher.ts
 * @purpose Watches ~/aria-review/ for dropped files and processes them automatically.
 *          - PDF files → AP invoice pipeline (classify → extract → reconcile)
 *          - .txt files → LLM Q&A against Supabase/Finale data; response written back
 * @author  Aria / Will
 * @created 2026-03-10
 */

import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { APAgent } from './ap-agent';
import { unifiedTextGeneration } from './llm';
import { createClient } from '../supabase';

// ── Directory layout ──────────────────────────────────────────────────────────
function getReviewDir(): string {
    return path.join(os.homedir(), 'aria-review');
}

function getProcessedDir(): string {
    return path.join(getReviewDir(), 'processed');
}

function getResponsesDir(): string {
    return path.join(getReviewDir(), 'responses');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDirs() {
    for (const dir of [getReviewDir(), getProcessedDir(), getResponsesDir()]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[aria-review] Created directory: ${dir}`);
        }
    }
}

function writeResponse(filename: string, content: string) {
    const dest = path.join(getResponsesDir(), filename);
    fs.writeFileSync(dest, content, 'utf8');
}

function moveToProcessed(filePath: string) {
    const filename = path.basename(filePath);
    const dest = path.join(getProcessedDir(), filename);
    try {
        // If a file with the same name already exists in processed, timestamp it
        if (fs.existsSync(dest)) {
            const ext = path.extname(filename);
            const base = path.basename(filename, ext);
            const stamped = `${base}-${Date.now()}${ext}`;
            fs.renameSync(filePath, path.join(getProcessedDir(), stamped));
        } else {
            fs.renameSync(filePath, dest);
        }
    } catch (err: any) {
        console.warn(`[aria-review] Could not move ${filename} to processed/: ${err.message}`);
    }
}

// ── PDF handler ───────────────────────────────────────────────────────────────

async function handlePDF(filePath: string, apAgent: APAgent) {
    const filename = path.basename(filePath);
    console.log(`[aria-review] Processing PDF: ${filename}`);

    let buffer: Buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (err: any) {
        console.error(`[aria-review] Cannot read ${filename}: ${err.message}`);
        writeResponse(`${filename}-error.txt`, `Failed to read file: ${err.message}`);
        return;
    }

    const supabase = createClient();

    try {
        // Use "aria-review" as the fake "from" address — no email context here.
        // Subject is the filename, which often carries useful PO/vendor info.
        await apAgent.processInvoiceBuffer(
            buffer,
            filename,
            filename,          // subject
            'aria-review',     // from
            supabase,
            false,
            undefined          // no Gmail message ID
        );

        writeResponse(
            `${filename}.txt`,
            `[aria-review] Invoice processed: ${filename}\n` +
            `Timestamp: ${new Date().toISOString()}\n` +
            `Status: Submitted to AP pipeline — check Telegram for reconciliation result.\n`
        );
        console.log(`[aria-review] PDF pipeline complete for: ${filename}`);
    } catch (err: any) {
        console.error(`[aria-review] PDF pipeline error for ${filename}: ${err.message}`);
        writeResponse(
            `${filename}-error.txt`,
            `[aria-review] AP pipeline failed for: ${filename}\n` +
            `Error: ${err.message}\n` +
            `Timestamp: ${new Date().toISOString()}\n`
        );
    }

    moveToProcessed(filePath);
}

// ── TXT handler ───────────────────────────────────────────────────────────────

/** Pull relevant records from Supabase for identifiers found in the question. */
async function fetchSupabaseContext(question: string): Promise<string> {
    const supabase = createClient();
    if (!supabase) return '';

    // ── Extract identifiers ────────────────────────────────────────────────────

    // PO numbers: "PO 89234", "PO-89234", "P.O. 89234", bare 4-7 digit numbers near PO keywords
    const poMatches = question.match(/\bP?O[-\s#.]?(\d{4,7})\b/gi) ?? [];
    const poNumbers = [...new Set(poMatches.map(m => m.replace(/\D/g, '')))];

    // Invoice numbers: "invoice INV-00421", "invoice #1234", etc.
    const invMatches = question.match(/\binvoice[-\s#]?([A-Z0-9-]{4,20})\b/gi) ?? [];
    const invoiceTokens = [...new Set(
        invMatches.map(m => m.replace(/^invoice[-\s#]*/i, '').trim()).filter(Boolean)
    )];

    // Vendor name words: words >4 chars that aren't common stopwords
    const STOPWORDS = /^(what|when|where|which|about|could|would|should|their|there|these|those|invoice|purchase|order|status|total|amount|dollar|price|please|check|find|show|tell|does|have|been|from|with|that|this|will|were|they|more|some|into|than|then|also|much|many|last|next|date|paid|sent|received|vendor)$/i;
    const vendorWords = question
        .split(/\s+/)
        .map(w => w.replace(/[^a-zA-Z0-9]/g, ''))
        .filter(w => w.length > 4 && !STOPWORDS.test(w));

    // ── Run queries in parallel ────────────────────────────────────────────────

    const lines: string[] = [];
    let anyDataFound = false;

    const queryPromises: Promise<void>[] = [];

    // PO number queries
    for (const n of poNumbers) {
        queryPromises.push((async () => {
            try {
                const { data: pos } = await supabase
                    .from('purchase_orders')
                    .select('po_number, vendor_name, total, status, created_at, line_items')
                    .ilike('po_number', `%${n}%`)
                    .limit(3);
                if (pos && pos.length > 0) {
                    anyDataFound = true;
                    for (const po of pos) {
                        const date = po.created_at ? po.created_at.slice(0, 10) : 'unknown date';
                        lines.push(`PO ${po.po_number}: ${po.vendor_name ?? 'unknown vendor'}, $${Number(po.total ?? 0).toFixed(2)}, ${po.status ?? 'unknown status'}, ${date}`);
                        if (Array.isArray(po.line_items) && po.line_items.length > 0) {
                            for (const li of po.line_items.slice(0, 5)) {
                                lines.push(`  Line: ${li.description ?? li.sku ?? ''} — qty ${li.quantity ?? '?'} @ $${Number(li.unitPrice ?? li.unit_price ?? 0).toFixed(2)}`);
                            }
                        }
                    }
                }
            } catch { /* skip silently */ }
        })());

        queryPromises.push((async () => {
            try {
                const { data: invs } = await supabase
                    .from('invoices')
                    .select('invoice_number, vendor_name, total, status, created_at, freight, tax, tariff')
                    .ilike('po_number', `%${n}%`)
                    .limit(3);
                if (invs && invs.length > 0) {
                    anyDataFound = true;
                    for (const inv of invs) {
                        const date = inv.created_at ? inv.created_at.slice(0, 10) : 'unknown date';
                        const extras: string[] = [];
                        if (inv.freight) extras.push(`freight: $${Number(inv.freight).toFixed(2)}`);
                        if (inv.tax) extras.push(`tax: $${Number(inv.tax).toFixed(2)}`);
                        if (inv.tariff) extras.push(`tariff: $${Number(inv.tariff).toFixed(2)}`);
                        const extrasStr = extras.length > 0 ? `, ${extras.join(', ')}` : '';
                        lines.push(`Invoice ${inv.invoice_number}: ${inv.vendor_name ?? 'unknown vendor'}, $${Number(inv.total ?? 0).toFixed(2)}, ${inv.status ?? 'unknown status'}, ${date}${extrasStr}`);
                    }
                }
            } catch { /* skip silently */ }
        })());
    }

    // Invoice token queries (when no PO numbers anchored them)
    for (const token of invoiceTokens) {
        queryPromises.push((async () => {
            try {
                const { data: invs } = await supabase
                    .from('invoices')
                    .select('invoice_number, vendor_name, total, status, created_at, freight, tax, tariff')
                    .ilike('invoice_number', `%${token}%`)
                    .limit(3);
                if (invs && invs.length > 0) {
                    anyDataFound = true;
                    for (const inv of invs) {
                        const date = inv.created_at ? inv.created_at.slice(0, 10) : 'unknown date';
                        const extras: string[] = [];
                        if (inv.freight) extras.push(`freight: $${Number(inv.freight).toFixed(2)}`);
                        if (inv.tax) extras.push(`tax: $${Number(inv.tax).toFixed(2)}`);
                        if (inv.tariff) extras.push(`tariff: $${Number(inv.tariff).toFixed(2)}`);
                        const extrasStr = extras.length > 0 ? `, ${extras.join(', ')}` : '';
                        lines.push(`Invoice ${inv.invoice_number}: ${inv.vendor_name ?? 'unknown vendor'}, $${Number(inv.total ?? 0).toFixed(2)}, ${inv.status ?? 'unknown status'}, ${date}${extrasStr}`);
                    }
                }
            } catch { /* skip silently */ }
        })());
    }

    // AP activity log — search for any vendor word match in the last 7 days
    if (vendorWords.length > 0) {
        queryPromises.push((async () => {
            try {
                const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
                // Run one query per vendor word; stop collecting after 5 total hits
                const activityLines: string[] = [];
                for (const word of vendorWords.slice(0, 4)) {
                    if (activityLines.length >= 5) break;
                    try {
                        const { data: acts } = await supabase
                            .from('ap_activity_log')
                            .select('created_at, action, email_subject, notes')
                            .ilike('email_subject', `%${word}%`)
                            .gte('created_at', sevenDaysAgo)
                            .order('created_at', { ascending: false })
                            .limit(3);
                        if (acts && acts.length > 0) {
                            for (const act of acts) {
                                if (activityLines.length >= 5) break;
                                const date = act.created_at ? act.created_at.slice(0, 10) : '?';
                                const notes = act.notes ? ` — ${String(act.notes).slice(0, 80)}` : '';
                                activityLines.push(`[${date}] ${act.action ?? 'action'}: "${act.email_subject ?? ''}"${notes}`);
                            }
                        }
                    } catch { /* skip silently */ }
                }
                if (activityLines.length > 0) {
                    anyDataFound = true;
                    lines.push(`Recent AP activity (last 7 days):`);
                    for (const al of activityLines) lines.push(`  ${al}`);
                }
            } catch { /* skip silently */ }
        })());
    }

    await Promise.all(queryPromises);

    if (!anyDataFound || lines.length === 0) return '';

    return [
        '=== Fetched data for your question ===',
        ...lines,
        '=== End of fetched data ===',
    ].join('\n');
}

async function handleTXT(filePath: string) {
    const filename = path.basename(filePath);
    const basename = path.basename(filename, path.extname(filename));
    console.log(`[aria-review] Processing question: ${filename}`);

    let question: string;
    try {
        question = fs.readFileSync(filePath, 'utf8').trim();
    } catch (err: any) {
        console.error(`[aria-review] Cannot read ${filename}: ${err.message}`);
        writeResponse(`${filename}-error.txt`, `Failed to read question file: ${err.message}`);
        return;
    }

    if (!question) {
        writeResponse(`${basename}-response.txt`, `[aria-review] Empty question file — nothing to answer.\n`);
        moveToProcessed(filePath);
        return;
    }

    // ── Fetch Supabase context ─────────────────────────────────────────────────
    let dataContext = '';
    let supabaseAvailable = true;
    try {
        dataContext = await fetchSupabaseContext(question);
    } catch (err: any) {
        console.warn(`[aria-review] Supabase context fetch failed: ${err.message}`);
        supabaseAvailable = false;
    }
    if (!supabaseAvailable || createClient() === null) {
        supabaseAvailable = false;
    }

    // If no matching records were found, say so explicitly so the LLM doesn't invent data
    if (supabaseAvailable && !dataContext) {
        dataContext = 'No matching records found in Supabase for the identifiers in this question.';
    }

    // ── Build prompt ───────────────────────────────────────────────────────────
    const dataBlock = dataContext
        ? `${dataContext}\n\n`
        : '[Note: Could not fetch Supabase data — answer may not reflect current records]\n\n';

    const prompt =
        `${dataBlock}` +
        `Question: ${question}\n\n` +
        `Answer using the fetched data above. Be specific — reference actual PO numbers, dollar amounts, dates from the data. ` +
        `If the data doesn't fully answer the question, say what's missing.`;

    try {
        const answer = await unifiedTextGeneration({
            system:
                'You are Aria, BuildASoil operations assistant. ' +
                'Answer the question using the Supabase data provided above the question. ' +
                'Be specific and direct — cite PO numbers, invoice numbers, dollar amounts, and dates from the data. ' +
                'Do not hedge or ask clarifying questions. If the fetched data is insufficient, state exactly what is missing.',
            prompt,
        });

        const responseContent =
            `[aria-review] Question: ${filename}\n` +
            `Timestamp: ${new Date().toISOString()}\n` +
            `---\n` +
            `Q: ${question}\n\n` +
            `A: ${answer}\n`;

        writeResponse(`${basename}-response.txt`, responseContent);
        console.log(`[aria-review] Answered question: ${filename}`);
    } catch (err: any) {
        console.error(`[aria-review] LLM error for ${filename}: ${err.message}`);
        writeResponse(
            `${basename}-error.txt`,
            `[aria-review] Failed to answer: ${filename}\n` +
            `Error: ${err.message}\n` +
            `Timestamp: ${new Date().toISOString()}\n`
        );
    }

    moveToProcessed(filePath);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function initAriaReviewWatcher(apAgent: APAgent): Promise<void> {
    ensureDirs();

    const reviewDir = getReviewDir();

    // Simple sequential lock — no queue needed, errors are isolated per file
    let processing = false;

    const watcher = chokidar.watch(
        [
            path.join(reviewDir, '*.pdf'),
            path.join(reviewDir, '*.PDF'),
            path.join(reviewDir, '*.txt'),
        ],
        {
            ignored: /(^|[/\\])\../, // ignore dotfiles
            ignoreInitial: true,      // don't reprocess files already present on startup
            persistent: true,
            awaitWriteFinish: {
                // Wait for the file to stop growing before firing — avoids partial reads
                stabilityThreshold: 1000,
                pollInterval: 200,
            },
        }
    );

    watcher.on('add', async (filePath: string) => {
        if (processing) {
            console.log(`[aria-review] Busy — queuing deferred: ${path.basename(filePath)}`);
            // Simple spin-wait: re-emit after current file finishes
            const waitAndRetry = async () => {
                while (processing) {
                    await new Promise(r => setTimeout(r, 500));
                }
                await dispatch(filePath);
            };
            waitAndRetry().catch((err: any) =>
                console.error(`[aria-review] Deferred dispatch error: ${err.message}`)
            );
            return;
        }
        await dispatch(filePath);
    });

    watcher.on('error', (err: unknown) => {
        console.error(`[aria-review] Watcher error:`, err);
    });

    async function dispatch(filePath: string) {
        processing = true;
        try {
            const ext = path.extname(filePath).toLowerCase();
            if (ext === '.pdf') {
                await handlePDF(filePath, apAgent);
            } else if (ext === '.txt') {
                await handleTXT(filePath);
            }
        } catch (err: any) {
            // Belt-and-suspenders: individual handlers already catch, but keep watcher alive
            console.error(`[aria-review] Unhandled dispatch error for ${path.basename(filePath)}: ${err.message}`);
        } finally {
            processing = false;
        }
    }

    console.log(`[aria-review] Watching ${reviewDir} — drop PDFs or .txt questions`);
}
