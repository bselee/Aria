import { NextResponse } from 'next/server';
import { gmail as GmailApi } from '@googleapis/gmail';
import { createClient } from '@/lib/supabase';
import { APAgent } from '@/lib/intelligence/ap-agent';
import { Telegraf } from 'telegraf';
import { getAuthenticatedClient } from '@/lib/gmail/auth';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { action_type, filename, bufferBase64 } = body;

        if (action_type !== 'process_invoice') {
            return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
        }

        if (!bufferBase64 || !filename) {
            return NextResponse.json({ error: 'Missing file data' }, { status: 400 });
        }

        const buffer = Buffer.from(bufferBase64, 'base64');
        const supabase = createClient();

        const token = process.env.TELEGRAM_BOT_TOKEN;
        if (!token) return NextResponse.json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, { status: 500 });
        const bot = new Telegraf(token);
        const apAgent = new APAgent(bot);

        const auth = await getAuthenticatedClient('ap').catch(() => getAuthenticatedClient('default'));
        const gmail = GmailApi({ version: 'v1', auth });

        const fromString = "Uploaded via Operations Dashboard";
        const subjectString = `Dashboard Upload: ${filename}`;

        console.log(`[Invoice Action] Forwarding manual upload ${filename} to Bill.com...`);
        // Forward to Bill.com
        await apAgent.forwardToBillCom(gmail, subjectString, filename, buffer);

        // Process invoice in background — OCR + Finale reconciliation can take 30-60s.
        // Results arrive via Telegram (approval buttons or auto-apply summary).
        console.log(`[Invoice Action] Kicking off background reconciliation for ${filename}...`);
        apAgent.processInvoiceBuffer(buffer, filename, subjectString, fromString, supabase, false)
            .catch((err: any) => console.error(`[Invoice Action] Background processing failed for ${filename}:`, err));

        return NextResponse.json({ success: true, status: 'processing', message: 'Invoice forwarded to Bill.com. Reconciliation running in background — results via Telegram.' });
    } catch (err: any) {
        console.error('Invoice action error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
