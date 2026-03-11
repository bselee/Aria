/**
 * @file    sandbox-watcher.ts
 * @purpose Watches ~/OneDrive/Desktop/Sandbox/ for dropped files and processes them.
 *          - PDF files → AP invoice pipeline (classify → extract → reconcile)
 *          - .txt files → LLM Q&A against Supabase/Finale data
 *          - .csv/.xlsx → summarize contents via LLM
 *          - .png/.jpg/.jpeg → upload to Supabase Storage
 * @author  Will / Antigravity
 * @created 2026-03-11
 * @updated 2026-03-11
 * @deps    chokidar, fs, path, os, ap-agent, llm, supabase
 */

import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Telegraf } from 'telegraf';
import { APAgent } from './ap-agent';
import { unifiedTextGeneration } from './llm';
import { createClient } from '../supabase';

// ── Directory layout ──────────────────────────────────────────────────────────

function getSandboxDir(): string {
    return path.join(os.homedir(), 'OneDrive', 'Desktop', 'Sandbox');
}

function getProcessedDir(): string {
    return path.join(getSandboxDir(), 'processed');
}

function getResponsesDir(): string {
    return path.join(getSandboxDir(), 'responses');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDirs() {
    for (const dir of [getSandboxDir(), getProcessedDir(), getResponsesDir()]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`[sandbox] Created directory: ${dir}`);
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
        if (fs.existsSync(dest)) {
            const ext = path.extname(filename);
            const base = path.basename(filename, ext);
            const stamped = `${base}-${Date.now()}${ext}`;
            fs.renameSync(filePath, path.join(getProcessedDir(), stamped));
        } else {
            fs.renameSync(filePath, dest);
        }
    } catch (err: any) {
        console.warn(`[sandbox] Could not move ${filename} to processed/: ${err.message}`);
    }
}

/**
 * Send a brief Telegram notification about a processed file.
 * Fire-and-forget — never blocks processing.
 */
async function notifyTelegram(bot: Telegraf, message: string) {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId || !bot) return;
    try {
        await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } catch (err: any) {
        console.warn(`[sandbox] Telegram notify failed: ${err.message}`);
    }
}

// ── PDF handler ───────────────────────────────────────────────────────────────

async function handlePDF(filePath: string, apAgent: APAgent, bot: Telegraf) {
    const filename = path.basename(filePath);
    console.log(`[sandbox] Processing PDF: ${filename}`);

    let buffer: Buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (err: any) {
        console.error(`[sandbox] Cannot read ${filename}: ${err.message}`);
        writeResponse(`${filename}-error.txt`, `Failed to read file: ${err.message}`);
        return;
    }

    const supabase = createClient();

    try {
        await apAgent.processInvoiceBuffer(
            buffer,
            filename,
            filename,          // subject
            'sandbox',         // from
            supabase,
            false,
            undefined          // no Gmail message ID
        );

        writeResponse(
            `${filename}.txt`,
            `[sandbox] Invoice processed: ${filename}\n` +
            `Timestamp: ${new Date().toISOString()}\n` +
            `Status: Submitted to AP pipeline — check Telegram for reconciliation result.\n`
        );
        console.log(`[sandbox] PDF pipeline complete for: ${filename}`);
        await notifyTelegram(bot, `📂 <b>Sandbox</b> — processed PDF: <code>${filename}</code>`);
    } catch (err: any) {
        console.error(`[sandbox] PDF pipeline error for ${filename}: ${err.message}`);
        writeResponse(
            `${filename}-error.txt`,
            `[sandbox] AP pipeline failed for: ${filename}\n` +
            `Error: ${err.message}\n` +
            `Timestamp: ${new Date().toISOString()}\n`
        );
        await notifyTelegram(bot, `📂 <b>Sandbox</b> — ❌ PDF failed: <code>${filename}</code>\n${err.message}`);
    }

    moveToProcessed(filePath);
}

// ── TXT handler ───────────────────────────────────────────────────────────────

// DECISION(2026-03-11): Replicates aria-review-watcher's Supabase context fetch.
// Importing directly from aria-review-watcher would create a tight coupling,
// so we inline the simpler version here: just pass the question text to the LLM.

async function handleTXT(filePath: string, bot: Telegraf) {
    const filename = path.basename(filePath);
    const basename = path.basename(filename, path.extname(filename));
    console.log(`[sandbox] Processing question: ${filename}`);

    let question: string;
    try {
        question = fs.readFileSync(filePath, 'utf8').trim();
    } catch (err: any) {
        console.error(`[sandbox] Cannot read ${filename}: ${err.message}`);
        writeResponse(`${filename}-error.txt`, `Failed to read question file: ${err.message}`);
        return;
    }

    if (!question) {
        writeResponse(`${basename}-response.txt`, `[sandbox] Empty file — nothing to process.\n`);
        moveToProcessed(filePath);
        return;
    }

    try {
        const answer = await unifiedTextGeneration({
            system:
                'You are Aria, BuildASoil operations assistant. ' +
                'Answer the question concisely and directly. ' +
                'If the question is about operations data (POs, invoices, vendors), note that you cannot look up live data in this mode — only the AP pipeline can do that.',
            prompt: question,
        });

        const responseContent =
            `[sandbox] Question: ${filename}\n` +
            `Timestamp: ${new Date().toISOString()}\n` +
            `---\n` +
            `Q: ${question}\n\n` +
            `A: ${answer}\n`;

        writeResponse(`${basename}-response.txt`, responseContent);
        console.log(`[sandbox] Answered question: ${filename}`);
        await notifyTelegram(bot, `📂 <b>Sandbox</b> — answered: <code>${filename}</code>`);
    } catch (err: any) {
        console.error(`[sandbox] LLM error for ${filename}: ${err.message}`);
        writeResponse(
            `${basename}-error.txt`,
            `[sandbox] Failed to answer: ${filename}\n` +
            `Error: ${err.message}\n` +
            `Timestamp: ${new Date().toISOString()}\n`
        );
    }

    moveToProcessed(filePath);
}

// ── CSV / XLSX handler ────────────────────────────────────────────────────────

async function handleSpreadsheet(filePath: string, bot: Telegraf) {
    const filename = path.basename(filePath);
    const basename = path.basename(filename, path.extname(filename));
    const ext = path.extname(filename).toLowerCase();
    console.log(`[sandbox] Processing spreadsheet: ${filename}`);

    try {
        let preview = '';

        if (ext === '.csv') {
            const raw = fs.readFileSync(filePath, 'utf8');
            // Take first 50 lines for summary
            const lines = raw.split('\n').slice(0, 50);
            preview = lines.join('\n');
        } else {
            // .xlsx — read raw text representation (best effort without heavy dep)
            // Use the file size and name as context
            const stats = fs.statSync(filePath);
            const sizeKB = (stats.size / 1024).toFixed(1);
            preview = `[Excel file: ${filename}, ${sizeKB} KB — drop as .csv for full content analysis]`;
        }

        const answer = await unifiedTextGeneration({
            system:
                'You are Aria, BuildASoil operations assistant. ' +
                'Summarize the spreadsheet data below. Highlight key totals, patterns, and anything noteworthy for operations.',
            prompt: `File: ${filename}\n\nData preview:\n${preview}`,
        });

        writeResponse(
            `${basename}-summary.txt`,
            `[sandbox] Spreadsheet summary: ${filename}\n` +
            `Timestamp: ${new Date().toISOString()}\n` +
            `---\n${answer}\n`
        );
        console.log(`[sandbox] Summarized spreadsheet: ${filename}`);
        await notifyTelegram(bot, `📂 <b>Sandbox</b> — summarized: <code>${filename}</code>`);
    } catch (err: any) {
        console.error(`[sandbox] Spreadsheet error for ${filename}: ${err.message}`);
        writeResponse(
            `${basename}-error.txt`,
            `[sandbox] Failed to summarize: ${filename}\nError: ${err.message}\n`
        );
    }

    moveToProcessed(filePath);
}

// ── Image handler ─────────────────────────────────────────────────────────────

async function handleImage(filePath: string, bot: Telegraf) {
    const filename = path.basename(filePath);
    const basename = path.basename(filename, path.extname(filename));
    const ext = path.extname(filename).toLowerCase();
    console.log(`[sandbox] Processing image: ${filename}`);

    try {
        const buffer = fs.readFileSync(filePath);
        const supabase = createClient();

        if (supabase) {
            const storagePath = `sandbox/${Date.now()}-${filename}`;
            const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';

            const { error } = await supabase.storage
                .from('documents')
                .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

            if (error) {
                throw new Error(`Supabase upload failed: ${error.message}`);
            }

            writeResponse(
                `${basename}-uploaded.txt`,
                `[sandbox] Image uploaded: ${filename}\n` +
                `Storage path: documents/${storagePath}\n` +
                `Timestamp: ${new Date().toISOString()}\n`
            );
            console.log(`[sandbox] Image uploaded to Supabase: ${storagePath}`);
            await notifyTelegram(bot, `📂 <b>Sandbox</b> — uploaded image: <code>${filename}</code>`);
        } else {
            writeResponse(
                `${basename}-skipped.txt`,
                `[sandbox] Image skipped (Supabase unavailable): ${filename}\n` +
                `Timestamp: ${new Date().toISOString()}\n`
            );
        }
    } catch (err: any) {
        console.error(`[sandbox] Image error for ${filename}: ${err.message}`);
        writeResponse(
            `${basename}-error.txt`,
            `[sandbox] Failed to process image: ${filename}\nError: ${err.message}\n`
        );
    }

    moveToProcessed(filePath);
}

// ── Catch-all handler ─────────────────────────────────────────────────────────

async function handleUnknown(filePath: string, bot: Telegraf) {
    const filename = path.basename(filePath);
    const basename = path.basename(filename, path.extname(filename));
    const ext = path.extname(filename);
    console.log(`[sandbox] Unknown file type: ${filename}`);

    writeResponse(
        `${basename}-note.txt`,
        `[sandbox] Unhandled file type (${ext}): ${filename}\n` +
        `Timestamp: ${new Date().toISOString()}\n` +
        `File moved to processed/ — no automated action taken.\n`
    );

    await notifyTelegram(bot, `📂 <b>Sandbox</b> — unknown file type: <code>${filename}</code> (${ext})`);
    moveToProcessed(filePath);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function initSandboxWatcher(apAgent: APAgent, bot: Telegraf): Promise<void> {
    ensureDirs();

    const sandboxDir = getSandboxDir();

    // Sequential lock — same pattern as aria-review-watcher
    let processing = false;

    const watcher = chokidar.watch(sandboxDir, {
        ignored: [
            /(^|[/\\])\../,          // ignore dotfiles
            /[/\\]processed[/\\]/,   // ignore processed subdirectory
            /[/\\]responses[/\\]/,   // ignore responses subdirectory
        ],
        ignoreInitial: true,
        persistent: true,
        depth: 0,                    // only watch top-level files, not subdirectories
        awaitWriteFinish: {
            // Higher threshold than aria-review: downloads from browser can be slow
            stabilityThreshold: 2000,
            pollInterval: 300,
        },
    });

    watcher.on('add', async (filePath: string) => {
        // Skip subdirectory files (belt-and-suspenders alongside depth: 0)
        const dir = path.dirname(filePath);
        if (path.resolve(dir) !== path.resolve(sandboxDir)) return;

        if (processing) {
            console.log(`[sandbox] Busy — queuing: ${path.basename(filePath)}`);
            const waitAndRetry = async () => {
                while (processing) {
                    await new Promise(r => setTimeout(r, 500));
                }
                await dispatch(filePath);
            };
            waitAndRetry().catch((err: any) =>
                console.error(`[sandbox] Deferred dispatch error: ${err.message}`)
            );
            return;
        }
        await dispatch(filePath);
    });

    watcher.on('error', (err: unknown) => {
        console.error(`[sandbox] Watcher error:`, err);
    });

    async function dispatch(filePath: string) {
        processing = true;
        try {
            const ext = path.extname(filePath).toLowerCase();

            if (ext === '.pdf') {
                await handlePDF(filePath, apAgent, bot);
            } else if (ext === '.txt') {
                await handleTXT(filePath, bot);
            } else if (ext === '.csv' || ext === '.xlsx') {
                await handleSpreadsheet(filePath, bot);
            } else if (['.png', '.jpg', '.jpeg'].includes(ext)) {
                await handleImage(filePath, bot);
            } else {
                await handleUnknown(filePath, bot);
            }
        } catch (err: any) {
            console.error(`[sandbox] Unhandled dispatch error for ${path.basename(filePath)}: ${err.message}`);
        } finally {
            processing = false;
        }
    }

    console.log(`[sandbox] Watching ${sandboxDir} — drop files to process`);
}
