import { createClient } from '../supabase';

export async function logChatMessage(params: {
  source: 'telegram' | 'slack';
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  try {
    const db = createClient();
    if (!db) return;
    await db.from('sys_chat_logs').insert({
      source: params.source,
      role: params.role,
      content: params.content,
      metadata: params.metadata || null,
    });
  } catch {
    // Never block message handling due to logging failure
  }
}
