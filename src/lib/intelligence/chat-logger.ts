import { createClient } from '../supabase';

export async function logChatMessage(params: {
  source:    'telegram' | 'slack';
  role:      'user' | 'assistant';
  content:   string;
  threadId?: string;           // chatId (telegram) or channelId (slack) — for context window
  metadata?: Record<string, any>;
}): Promise<void> {
  try {
    const db = createClient();
    if (!db) return;
    const metadata = {
      ...(params.metadata ?? {}),
      ...(params.threadId ? { thread_id: params.threadId } : {}),
    };

    await db.from('sys_chat_logs').insert({
      source:   params.source,
      role:     params.role,
      content:  params.content,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    });
  } catch {
    // Never block message handling due to logging failure
  }
}
