/**
 * @file    route.ts
 * @purpose API endpoint to manually trigger the OOS report generation.
 *          GET /api/dashboard/oos-report — scans Gmail for the Stockie Low Stock Alert,
 *          generates the enriched report, and saves it to the Sandbox folder.
 * @author  Antigravity / ARIA
 * @created 2026-03-11
 * @updated 2026-03-11
 * @deps    oos-email-trigger
 */

import { NextResponse } from 'next/server';
import { processStockieEmail } from '@/lib/reports/oos-email-trigger';

export async function GET() {
    try {
        const result = await processStockieEmail();

        if (!result) {
            return NextResponse.json({
                success: false,
                message: 'No unprocessed Stockie Low Stock Alert email found in the last 24 hours.',
            }, { status: 404 });
        }

        return NextResponse.json({
            success: true,
            outputPath: result.outputPath,
            totalItems: result.totalItems,
            summary: {
                needsOrder: result.needsOrder,
                onOrder: result.onOrder,
                agingPOs: result.agingPOs,
                internalBuild: result.internalBuild,
                notInFinale: result.notInFinale,
            },
        });
    } catch (err: any) {
        console.error('[OOS-Report API] Error:', err.message);
        return NextResponse.json({
            success: false,
            error: err.message,
        }, { status: 500 });
    }
}
