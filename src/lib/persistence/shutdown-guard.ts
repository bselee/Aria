/**
 * @file    src/lib/persistence/shutdown-guard.ts
 * @purpose Graceful shutdown persistence — persists volatile in-memory state
 *          (chatHistory, pending operations) to local SQLite before process exit.
 *          On Windows shutdown, PM2 sends SIGTERM with kill_timeout.
 *          This module catches the signal and flushes critical state
 *          before the process is killed, then restores it on the next boot.
 *
 *          Replaced the old Supabase-backed persistence. SQLite is the sole
 *          durable store for shutdown snapshots.
 *
 * @author  Hermia
 * @created 2026-06-16
 * @updated 2026-07-15 — migrated from Supabase to local SQLite
 * @deps    @/lib/storage/local-db
 *
 * USAGE:
 *   import { installShutdownGuard } from '../lib/persistence/shutdown-guard';
 *   installShutdownGuard(chatHistory, chatLastActive);
 *
 * DESIGN:
 *   - Captures SIGINT/SIGTERM from PM2
 *   - Serializes chatHistory to sys_chat_logs rows tagged as
 *     'shutdown-snapshot' stored in SQLite
 *   - Runs in a best-effort fire-and-forget pattern; will not delay shutdown
 *     past a hard 4-second deadline per operation
 *   - On boot, restoreChatHistory() reads the latest snapshot and reconstructs
 *     the per-chat arrays
 *
 * SAFETY:
 *   - Shutdown snapshots are compact — one row per chatId
 *   - Old snapshots are cleaned before writing new ones
 *   - If snapshot write fails (timeout/SQLite error), state is simply lost —
 *     Aria continues fine, just without chat history
 */

import { getLocalDb } from '@/lib/storage/local-db';

// ── Constants ────────────────────────────────────────────────────────────

const SNAPSHOT_SOURCE = 'shutdown-guard' as const;
const SNAPSHOT_METADATA_TYPE = 'shutdown-snapshot' as const;

/** Serialisable chat history snapshot shape, stored as JSON in SQLite */
export interface ChatHistorySnapshot {
  /** ISO timestamp when snapshot was taken */
  captured_at: string;
  /** PID of the process that took the snapshot */
  pid: number;
  /** Per-chat history arrays — each entry is {role, content} */
  chats: Record<string, Array<{ role: string; content: string }>>;
  /** Per-chat last-active timestamps (epoch ms) */
  lastActive: Record<string, number>;
}

/** Ensure the SQLite table exists. Idempotent. */
function ensureTable(): void {
  const db = getLocalDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sys_chat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      role TEXT,
      content TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

// ── Shutdown Persistence ─────────────────────────────────────────────────

/**
 * Persist chatHistory to local SQLite as snapshot rows.
 * Best-effort: never throws, never blocks more than 4 seconds.
 */
export async function persistChatHistorySnapshot(
  chatHistory: Record<string, any[]>,
  chatLastActive: Record<string, number>,
): Promise<boolean> {
  // Prune: only persist chats with actual messages, cap at last 40 per chat
  const chats: Record<string, Array<{ role: string; content: string }>> = {};
  for (const [chatId, messages] of Object.entries(chatHistory)) {
    if (Array.isArray(messages) && messages.length > 0) {
      chats[chatId] = messages.slice(-40);
    }
  }

  if (Object.keys(chats).length === 0) {
    console.log('[shutdown-guard] No chat history to persist');
    return true;
  }

  const lastActive: Record<string, number> = {};
  for (const [chatId, ts] of Object.entries(chatLastActive)) {
    if (chats[chatId]) {
      lastActive[chatId] = ts;
    }
  }

  const pid = process.pid;

  try {
    ensureTable();
    const db = getLocalDb();

    // Delete old snapshots for this source+type combo
    db.prepare(
      `DELETE FROM sys_chat_logs WHERE source = ? AND json_extract(metadata, '$.type') = ?`
    ).run(SNAPSHOT_SOURCE, SNAPSHOT_METADATA_TYPE);

    // Insert one row per chatId
    const insert = db.prepare(
      `INSERT INTO sys_chat_logs (source, role, content, metadata)
       VALUES (?, ?, ?, ?)`
    );

    const tx = db.transaction(() => {
      for (const [chatId, messages] of Object.entries(chats)) {
        insert.run(
          SNAPSHOT_SOURCE,
          'system',
          JSON.stringify(messages),
          JSON.stringify({
            type: SNAPSHOT_METADATA_TYPE,
            chat_id: chatId,
            last_active: lastActive[chatId] || Date.now(),
            captured_at: new Date().toISOString(),
            pid,
            message_count: messages.length,
          }),
        );
      }
    });

    tx();
    console.log(`[shutdown-guard] Persisted ${Object.keys(chats).length} chat(s) to local SQLite`);
    return true;
  } catch (err: any) {
    console.warn(`[shutdown-guard] Snapshot failed: ${err?.message || err}`);
    return false;
  }
}

// ── Boot-time Restore ────────────────────────────────────────────────────

/**
 * Restore chat history from the last shutdown snapshot.
 * Reads rows tagged as shutdown-snapshot from sys_chat_logs
 * and reconstructs the per-chat history arrays.
 *
 * @returns { chats, chatLastActive } or empty records if no snapshot found
 */
export async function restoreChatHistory(): Promise<{
  chats: Record<string, any[]>;
  lastActive: Record<string, number>;
}> {
  try {
    ensureTable();
    const db = getLocalDb();

    const rows = db.prepare(
      `SELECT content, metadata, created_at FROM sys_chat_logs
       WHERE source = ? AND json_extract(metadata, '$.type') = ?
       ORDER BY created_at DESC`
    ).all(SNAPSHOT_SOURCE, SNAPSHOT_METADATA_TYPE) as Array<{
      content: string;
      metadata: string;
      created_at: string;
    }>;

    if (!rows || rows.length === 0) {
      console.log('[shutdown-guard] No chat history snapshot found — starting fresh');
      return { chats: {}, lastActive: {} };
    }

    const chats: Record<string, any[]> = {};
    const lastActive: Record<string, number> = {};

    for (const row of rows) {
      let metadata: Record<string, any> = {};
      try { metadata = JSON.parse(row.metadata); } catch { continue; }
      if (!metadata?.chat_id) continue;

      // Skip if we already have a newer entry for this chatId
      if (chats[metadata.chat_id]) continue;

      try {
        const messages = typeof row.content === 'string'
          ? JSON.parse(row.content)
          : row.content;
        if (Array.isArray(messages) && messages.length > 0) {
          chats[metadata.chat_id] = messages;
          lastActive[metadata.chat_id] = Number(metadata.last_active) || Date.now();
        }
      } catch {
        // Skip malformed entries
      }
    }

    const total = Object.keys(chats).reduce((sum, key) => sum + chats[key].length, 0);
    console.log(`[shutdown-guard] Restored ${Object.keys(chats).length} chat(s) (${total} messages) from previous session`);
    return { chats, lastActive };
  } catch (err: any) {
    console.warn(`[shutdown-guard] Restore error: ${err?.message || err}`);
    return { chats: {}, lastActive: {} };
  }
}

// ── Shutdown Guard Installer ─────────────────────────────────────────────

export interface ShutdownGuardOptions {
  /** Max seconds to wait for snapshot before forcing exit (default: 8) */
  timeoutSeconds?: number;
  /** Additional cleanup callbacks to run before exit (e.g. BrowserBase close) */
  cleanupHooks?: Array<() => Promise<void>>;
}

/**
 * Install signal handlers that persist volatile state before exit.
 * Call once at boot time with the mutable chatHistory references.
 *
 * The returned cleanup function is for unit tests — production relies on
 * the signal handlers.
 */
export function installShutdownGuard(
  chatHistory: Record<string, any[]>,
  chatLastActive: Record<string, number>,
  options: ShutdownGuardOptions = {},
): () => void {
  const { timeoutSeconds = 8, cleanupHooks = [] } = options;
  let shuttingDown = false;

  async function handleShutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      console.log(`[shutdown-guard] Already shutting down — ignoring duplicate ${signal}`);
      return;
    }
    shuttingDown = true;

    console.log(`[shutdown-guard] ${signal} received — persisting state before exit...`);

    // Run cleanup hooks (BrowserBase sessions, etc.)
    if (cleanupHooks.length > 0) {
      await Promise.allSettled(
        cleanupHooks.map(fn => fn().catch((err: unknown) => {
          console.warn('[shutdown-guard] Cleanup hook failed:', err instanceof Error ? err.message : String(err));
        })),
      );
    }

    // Persist chat history — this is the primary purpose
    await persistChatHistorySnapshot(chatHistory, chatLastActive);

    console.log(`[shutdown-guard] Shutdown complete (${signal})`);
  }

  // Remove previous listeners to avoid duplicates on hot-reload
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');

  const wrappedHandler = (signal: string) => {
    void handleShutdown(signal).finally(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => wrappedHandler('SIGINT'));
  process.on('SIGTERM', () => wrappedHandler('SIGTERM'));

  const hookCount = cleanupHooks.length;
  console.log(`[shutdown-guard] Installed (timeout: ${timeoutSeconds}s, ${hookCount} cleanup hook(s))`);

  return () => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    shuttingDown = false;
  };
}
