import { NextResponse } from 'next/server';
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';

export async function POST(req: Request) {
    try {
        const { messages } = await req.json();

        // System prompt to set Aria's persona
        const systemPrompt = `You are Aria, the primary autonomous intelligence for BuildASoil's operations.
You are speaking to your operator through the Command Terminal.
Your tone should be precise, highly technical, slightly robotic, but cooperative.
Do not use excessive pleasantries. Acknowledge commands efficiently.
If asked to 'reconcile', say you are initializing the AP Agent reconciliation protocol.`;

        const { text } = await generateText({
            model: openai('gpt-4o-mini'),
            system: systemPrompt,
            messages,
        });

        return NextResponse.json({ message: text });
    } catch (error) {
        console.error('Terminal API Error:', error);
        return NextResponse.json({ error: 'Failed to communicate with Aria Core.' }, { status: 500 });
    }
}
