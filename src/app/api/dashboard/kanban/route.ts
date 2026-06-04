/**
 * @file    src/app/api/dashboard/kanban/route.ts
 * @purpose GET endpoint for Hermes kanban board tasks.
 *          Reads directly from the purchasing-lifecycle kanban.db.
 * @author  Hermia
 * @created 2026-06-02
 * @deps    better-sqlite3, Hermes kanban.db
 * @env     (none – direct filesystem read)
 */

import { NextResponse } from "next/server";
import Database from "better-sqlite3";
import * as path from "path";
import * as os from "os";

export const dynamic = "force-dynamic";

/** Lane definitions for the purchasing-lifecycle board */
const LANES = ["Ordering", "Purchasing", "Tracking", "Receiving"] as const;
type Lane = (typeof LANES)[number];

interface KanbanTask {
    id: string;
    title: string;
    status: string;
    priority: number;
    assignee: string;
    // denormalized lane from title prefix
    lane: Lane;
    created_at: string | null;
    started_at: string | null;
    completed_at: string | null;
    consecutive_failures: number;
    last_failure_error: string | null;
    result: string | null;
}

function getKanbanDbPath(): string {
    const hermesHome = process.env.HERMES_HOME
        || path.join(os.homedir(), "AppData", "Local", "hermes");
    return path.join(hermesHome, "kanban", "boards", "purchasing-lifecycle", "kanban.db");
}

/** Extract lane from the task title (e.g. "Ordering: Draft POs to vendors" → "Ordering") */
function extractLane(title: string): Lane {
    for (const lane of LANES) {
        if (title.startsWith(lane)) return lane;
    }
    return "Tracking"; // default fallback
}

function parseRow(row: Record<string, unknown>): KanbanTask {
    const title = String(row.title ?? "");
    return {
        id: String(row.id ?? ""),
        title,
        status: String(row.status ?? "ready"),
        priority: Number(row.priority ?? 0),
        assignee: String(row.assignee ?? ""),
        lane: extractLane(title),
        created_at: row.created_at ? String(row.created_at) : null,
        started_at: row.started_at ? String(row.started_at) : null,
        completed_at: row.completed_at ? String(row.completed_at) : null,
        consecutive_failures: Number(row.consecutive_failures ?? 0),
        last_failure_error: row.last_failure_error ? String(row.last_failure_error) : null,
        result: row.result ? String(row.result) : null,
    };
}

export async function GET(_request: Request): Promise<NextResponse> {
    const dbPath = getKanbanDbPath();

    let db: Database.Database | null = null;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const rows = db.prepare(`
            SELECT id, title, status, priority, assignee,
                   created_at, started_at, completed_at,
                   consecutive_failures, last_failure_error, result
            FROM tasks
            ORDER BY priority ASC, created_at DESC
        `).all() as Record<string, unknown>[];

        const tasks: KanbanTask[] = rows.map(parseRow);

        // Group tasks by lane
        const lanes: Record<Lane, KanbanTask[]> = {
            Ordering: [],
            Purchasing: [],
            Tracking: [],
            Receiving: [],
        };
        for (const task of tasks) {
            lanes[task.lane].push(task);
        }

        return NextResponse.json({
            lanes,
            tasks,
            board: "purchasing-lifecycle",
            dbPath,
        });
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json(
            { error: message, dbPath },
            { status: 500 },
        );
    } finally {
        db?.close();
    }
}
