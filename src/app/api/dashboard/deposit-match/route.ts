/**
 * @file    api/dashboard/deposit-match/route.ts
 * @purpose API endpoint for deposit matching. Reads specified CSV files or
 *          auto-discovers them in known paths, runs the reconciliation engine,
 *          and returns structured results for the dashboard panel.
 * @author  Hermia
 * @created 2026-07-16
 */
import { NextRequest, NextResponse } from 'next/server';
import { reconcileDeposit, parseCashReportCSV, parseFinaloopCSV } from '@/lib/intelligence/finaloop-reconciler';
import * as fs from 'fs';
import * as path from 'path';

/** Expected request body */
interface DepositMatchRequest {
    depositAmount: number;
    finaloopPath?: string;
    sheetPath?: string;
    /** If true, use Google Sheets API to fetch the latest Daily Cash Report */
    autoFetchSheet?: boolean;
}

/** Auto-discover CSVs in known directories */
function discoverCSVFiles(): { finaloopPath?: string; sheetPath?: string } {
    const searchDirs = [
        process.cwd(),
        path.join(process.cwd(), '.hermes', 'desktop-attachments'),
        path.join(process.cwd(), 'data'),
        path.join(process.cwd(), 'tmp'),
    ];

    let finaloopPath: string | undefined;
    let sheetPath: string | undefined;

    for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
            const files = fs.readdirSync(dir);

            if (!finaloopPath) {
                const finaloopFile = files.find(
                    (f: string) =>
                        (f.includes('Finaloop') || f.includes('finaloop')) &&
                        f.endsWith('.csv') &&
                        !f.includes('test-sheet')
                );
                if (finaloopFile) {
                    finaloopPath = path.join(dir, finaloopFile);
                }
            }

            if (!sheetPath) {
                const sheetFile = files.find(
                    (f: string) =>
                        f.includes('Daily Cash Report') ||
                        f.includes('daily-cash') ||
                        (f.includes('sheet') && f.endsWith('.csv')) ||
                        f.includes('cash-report')
                );
                if (sheetFile) {
                    sheetPath = path.join(dir, sheetFile);
                }
            }
        } catch { /* skip unreadable dirs */ }
    }

    return { finaloopPath, sheetPath };
}

export async function POST(request: NextRequest) {
    try {
        const body: DepositMatchRequest = await request.json();

        if (!body.depositAmount || isNaN(body.depositAmount) || body.depositAmount <= 0) {
            return NextResponse.json(
                { error: 'Valid depositAmount required' },
                { status: 400 },
            );
        }

        const depositAmount = body.depositAmount;

        // Discover or use provided paths
        const discovered = discoverCSVFiles();
        const finaloopPath = body.finaloopPath || discovered.finaloopPath;
        const sheetPath = body.sheetPath || discovered.sheetPath;

        if (!finaloopPath || !fs.existsSync(finaloopPath)) {
            return NextResponse.json(
                { error: 'Finaloop CSV not found. Export Draft Orders from Finaloop and save to .hermes/desktop-attachments/' },
                { status: 404 },
            );
        }

        if (!sheetPath || !fs.existsSync(sheetPath)) {
            return NextResponse.json(
                { error: 'Daily Cash Report CSV not found. Download from Google Drive and save to .hermes/desktop-attachments/' },
                { status: 404 },
            );
        }

        const finaloopCsv = fs.readFileSync(finaloopPath, 'utf-8');
        const sheetCsv = fs.readFileSync(sheetPath, 'utf-8');
        const sheetLabel = path.basename(sheetPath, path.extname(sheetPath));

        const result = reconcileDeposit(sheetCsv, finaloopCsv, depositAmount, sheetLabel);

        // Compute matched subset
        const { computeDepositCoverage } = await import('@/lib/intelligence/finaloop-reconciler');
        const coverage = computeDepositCoverage(depositAmount, result.unpaidOrders);

        return NextResponse.json({
            ...result,
            matchedSubset: coverage,
            finaloopFile: path.basename(finaloopPath),
            sheetFile: path.basename(sheetPath),
        });
    } catch (err: any) {
        console.error('[DepositMatch] Error:', err);
        return NextResponse.json(
            { error: err.message || 'Internal server error' },
            { status: 500 },
        );
    }
}

export async function GET() {
    // GET returns status — what files are available
    const discovered = discoverCSVFiles();
    const status: Record<string, any> = {
        filesFound: {},
        hasFinaloop: false,
        hasSheet: false,
        ready: false,
    };

    if (discovered.finaloopPath) {
        status.filesFound.finaloop = discovered.finaloopPath;
        status.hasFinaloop = true;
        try {
            const csv = fs.readFileSync(discovered.finaloopPath, 'utf-8');
            const parsed = parseFinaloopCSV(csv);
            const draftOrders = parsed.filter(o =>
                o.salesChannel.toLowerCase().includes('draft')
            );
            status.finaloopStats = {
                totalOrders: parsed.length,
                draftOrders: draftOrders.length,
                totalUnpaidBalance: draftOrders.reduce((s, o) => s + o.currentBalance, 0),
            };
        } catch { /* ignore parse errors on status check */ }
    }

    if (discovered.sheetPath) {
        status.filesFound.sheet = discovered.sheetPath;
        status.hasSheet = true;
        try {
            const csv = fs.readFileSync(discovered.sheetPath, 'utf-8');
            const parsed = parseCashReportCSV(csv);
            status.sheetStats = {
                orders: parsed.length,
                total: parsed.reduce((s, o) => s + o.amount, 0),
            };
        } catch { /* ignore */ }
    }

    status.ready = status.hasFinaloop && status.hasSheet;

    return NextResponse.json(status);
}
