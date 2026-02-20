import { ElevenLabsClient } from "elevenlabs";

// Initialize client based on available env configs
const client = new ElevenLabsClient({
    apiKey: process.env.ELEVENLABS_API_KEY,
});

export async function generateSpeech(text: string, voiceId: string = "21m00Tcm4TlvDq8ikWAM") {
    // Uses default Rachel voice if none is explicitly provided.
    try {
        const audioStream = await client.textToSpeech.convert(voiceId, {
            text,
            model_id: "eleven_monolingual_v1",
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.75,
            }
        });

        // Accumulate the audio stream into a buffer
        const chunks: Buffer[] = [];
        for await (const chunk of audioStream) {
            chunks.push(Buffer.from(chunk));
        }

        return Buffer.concat(chunks);
    } catch (error) {
        console.error("ElevenLabs speech generation failed:", error);
        throw new Error("Voice generation failed");
    }
}
