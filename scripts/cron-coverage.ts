/**
 * @file    scripts/cron-coverage.ts
 * @purpose Cron coverage checker for Aria. Proves every registered cron job is
 *          either firing on schedule or legitimately sparse, and flags
 *          silently-dead jobs (STALE).
 *
 * Method:
 *   1. Side-effect import of src/cron/jobs registers every job in the registry
 *      (handlers only import heavy deps dynamically, so nothing heavy loads).
 *   2. For each enabled job, fetch the most recent cron_runs row from local
 *      PostgREST (http://localhost:5434, no auth).
 *   3. A minute-granularity cron matcher over the 5 fields (minute, hour,
 *      day-of-month, month, day-of-week) supporting wildcard, step, single
 *      value, a-b range, and comma-list syntax. Enumerates fire times over a
 *      7-day window in Denver wall clock,
 *      unions multi-expression schedules, and computes maxGap = the largest
 *      gap between consecutive fires (including now -> first future fire).
 *   4. Classification:
 *        DISABLED  - enabled === false in the registry.
 *        OK        - last run age <= 2 * maxGap.
 *        SPARSE-OK - no run ever recorded, but the first future fire is within
 *                    one maxGap from now (cron_runs retention may have pruned
 *                    the history for a job that is about to fire).
 *        STALE     - last run older than 2 * maxGap, or no run and no imminent
 *                    fire. A silently-dead job.
 *   5. Exit code 1 if any STALE, else 0.
 *
 * Denver offset assumption: the America/Denver UTC offset is derived once via
 * Intl.DateTimeFormat and treated as constant across the 7-day window. This is
 * exact unless a DST transition falls inside the window (US transitions: 2nd
 * Sun Mar / 1st Sun Nov). A runtime sanity check compares the offset at now vs
 * now+7d and warns if they differ.
 *
 * Run:  node --import tsx scripts/cron-coverage.ts
 *       node --import tsx scripts/cron-coverage.ts --selftest
 */

import "../src/cron/jobs"; // side effect: registers every cron job
import { listJobs } from "../src/cron/registry";
import * as http from "node:http";

// ─────────────────────────────────────────────────────────────────────────────
// PostgREST read (node http.get only — never fetch(): undici is incompatible
// with PostgREST on Windows. No ?select= params — WSL bridge 502 bug.)
// ─────────────────────────────────────────────────────────────────────────────

const PGREST = "http://localhost:5434";

function fetchJson(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 15_000 }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () => {
                try {
                    if (res.statusCode !== 200) {
                        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
                    }
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on("timeout", () => req.destroy(new Error(`timeout fetching ${url}`)));
        req.on("error", reject);
    });
}

interface RunRow {
    started_at: string;
}

/** Most recent cron_runs row for a task, or null if none recorded. */
async function fetchLastRun(taskName: string): Promise<RunRow | null> {
    const url =
        `${PGREST}/cron_runs?task_name=eq.` +
        encodeURIComponent(taskName) +
        `&order=started_at.desc&limit=1`;
    const arr: any[] = await fetchJson(url);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return { started_at: arr[0].started_at };
}

// ─────────────────────────────────────────────────────────────────────────────
// Denver wall-clock offset (treated as constant over the 7-day window; see the
// DST assumption in the file header).
// ─────────────────────────────────────────────────────────────────────────────

function getDenverOffsetMinutes(atMs: number): number {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Denver",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(atMs))) parts[p.type] = p.value;
    const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour) % 24,
        Number(parts.minute),
        Number(parts.second)
    );
    return Math.round((atMs - asUtc) / 60_000);
}

const NOW_MS = Date.now();
const OFFSET_MIN = getDenverOffsetMinutes(NOW_MS);
const OFFSET_7D = getDenverOffsetMinutes(NOW_MS + 7 * 86_400_000);
if (OFFSET_MIN !== OFFSET_7D) {
    console.warn(
        `[cron-coverage] WARNING: a DST transition falls inside the 7-day window ` +
            `(offset ${OFFSET_MIN}min -> ${OFFSET_7D}min). Fire times are approximate.`
    );
}

/** Denver wall-clock minute index for a real instant. */
function denverEpochMin(tMs: number): number {
    return Math.floor((tMs - OFFSET_MIN * 60_000) / 60_000);
}

/** Real instant (ms) at which a Denver wall-clock minute occurs. */
function fireInstant(wMin: number): number {
    return (wMin + OFFSET_MIN) * 60_000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron engine — 5 fields: minute(0-59) hour(0-23) dom(1-31) month(1-12)
// dow(0-7, 0/7 = Sunday). Supports `*`, `*/n`, `n`, `a-b` (and a-b/n), comma
// lists, in any combination — the syntax actually used across src/cron/jobs.
// ─────────────────────────────────────────────────────────────────────────────

type FieldMatcher = (v: number) => boolean;

interface ParsedField {
    match: FieldMatcher;
    isStar: boolean;
}

function parseField(field: string, max: number): ParsedField {
    const parts = field.split(",").map((s) => s.trim());
    const matchers: FieldMatcher[] = [];
    let isStar = false;
    for (const part of parts) {
        if (part === "*") {
            isStar = true;
            matchers.push(() => true);
        } else if (/^\*\/(\d+)$/.test(part)) {
            const n = Number(/^\*\/(\d+)$/.exec(part)![1]);
            matchers.push((v) => v % n === 0);
        } else if (/^\d+-\d+(\/\d+)?$/.test(part)) {
            const m = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part)!;
            const a = Number(m[1]);
            const b = Number(m[2]);
            const n = m[3] ? Number(m[3]) : 1;
            matchers.push((v) => v >= a && v <= b && (v - a) % n === 0);
        } else if (/^\d+$/.test(part)) {
            const n = Number(part);
            matchers.push((v) => v === n);
        } else {
            throw new Error(`cron-coverage: cannot parse cron field "${field}"`);
        }
    }
    if (max < 0) {
        throw new Error(`cron-coverage: internal — negative field max for "${field}"`);
    }
    return { match: (v) => matchers.some((m) => m(v)), isStar };
}

interface CronExpr {
    minute: FieldMatcher;
    hour: FieldMatcher;
    dom: FieldMatcher;
    month: FieldMatcher;
    dow: FieldMatcher;
    domStar: boolean;
    dowStar: boolean;
}

function parseCron(schedule: string): CronExpr {
    const fields = schedule.trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new Error(`cron-coverage: "${schedule}" is not a 5-field cron expression`);
    }
    const [minute, hour, dom, month, dow] = fields;
    const m = parseField(minute, 59);
    const h = parseField(hour, 23);
    const d = parseField(dom, 31);
    const mo = parseField(month, 12);
    const dw = parseField(dow, 7);
    return {
        minute: m.match,
        hour: h.match,
        dom: d.match,
        month: mo.match,
        dow: dw.match,
        domStar: d.isStar,
        dowStar: dw.isStar,
    };
}

/** Does the expression fire at Denver wall-clock minute w? */
function matches(expr: CronExpr, w: number): boolean {
    const d = new Date(w * 60_000); // Denver wall clock, read as if UTC
    const minute = d.getUTCMinutes();
    const hour = d.getUTCHours();
    const dom = d.getUTCDate();
    const month = d.getUTCMonth() + 1;
    const dow = d.getUTCDay();

    if (!expr.minute(minute) || !expr.hour(hour) || !expr.month(month)) return false;

    const domOK = expr.dom(dom);
    // cron dow 7 = Sunday alias; JS getUTCDay() reports Sunday as 0.
    const dowOK = expr.dow(dow) || (dow === 0 && expr.dow(7));

    // Standard cron: when BOTH dom and dow are restricted, a date matches if
    // EITHER matches. When one is `*`, only the other constrains.
    if (!expr.domStar && !expr.dowStar) return domOK || dowOK;
    return (expr.domStar || domOK) && (expr.dowStar || dowOK);
}

interface ScheduleAnalysis {
    fires: number[]; // real instants (ms), sorted ascending, >= window start
    maxGapMs: number; // now -> first future fire, plus consecutive gaps
}

const MIN_PER_DAY = 1440;
const BASE_WINDOW_MIN = 7 * MIN_PER_DAY; // 10080 minutes
const MAX_WINDOW_MIN = 21 * MIN_PER_DAY; // safety cap for extension

/**
 * Enumerate fires for one job (union of all its expressions) over a 7-day
 * Denver window starting at now. If fewer than 2 fires are found (e.g. a
 * weekly job whose next occurrence is just past the window edge), extend the
 * scan until 2 fires are seen — needed to measure the true maxGap.
 */
function analyzeSchedules(schedules: string[], nowMs: number): ScheduleAnalysis {
    const exprs = schedules.map(parseCron);
    const startW = denverEpochMin(nowMs);
    const limitW = startW + BASE_WINDOW_MIN;
    const hardW = startW + MAX_WINDOW_MIN;

    const fires: number[] = [];
    let w = startW;
    while (w <= limitW || (fires.length < 2 && w < hardW)) {
        if (exprs.some((e) => matches(e, w))) fires.push(fireInstant(w));
        w++;
    }

    let maxGapMs = 0;
    let prev = nowMs;
    for (const f of fires) {
        const gap = f - prev;
        if (gap > maxGapMs) maxGapMs = gap;
        prev = f;
    }
    return { fires, maxGapMs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtH(h: number): string {
    if (h < 10) return h.toFixed(2) + "h";
    if (h < 100) return h.toFixed(1) + "h";
    return Math.round(h) + "h";
}

function pad(s: string, n: number): string {
    return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-test (--selftest): prove the matcher before trusting the table.
// Uses a fixed reference instant (2026-08-21 12:00 UTC = Fri 06:00 MDT) and
// wall-clock-only expected gaps, so the assertions are DST-offset independent.
// ─────────────────────────────────────────────────────────────────────────────

function selftest(): void {
    const now = Date.UTC(2026, 7, 21, 12, 0, 0); // Fri 06:00 Denver (MDT)
    const MIN = 60_000;
    const HOUR = 3_600_000;
    const DAY = 24 * HOUR;
    let fails = 0;

    function check(cond: boolean, msg: string): void {
        if (!cond) {
            console.error(`  SELFTEST FAIL: ${msg}`);
            fails++;
        }
    }

    let r = analyzeSchedules(["* * * * *"], now);
    check(r.maxGapMs === MIN, `every-minute maxGap ${fmtH(r.maxGapMs / HOUR)} (want 0.02h)`);
    check(r.fires.length >= 7 * MIN_PER_DAY, `every-minute fire count ${r.fires.length}`);

    r = analyzeSchedules(["*/30 * * * *"], now);
    check(r.maxGapMs === 30 * MIN, `*/30 maxGap ${fmtH(r.maxGapMs / HOUR)} (want 0.50h)`);

    r = analyzeSchedules(["30 7 * * *"], now);
    check(r.maxGapMs === DAY, `"30 7 * * *" maxGap ${fmtH(r.maxGapMs / HOUR)} (want 24h)`);

    r = analyzeSchedules(["0 12,17 * * *"], now);
    check(
        r.maxGapMs === 19 * HOUR,
        `comma-list "0 12,17 * * *" maxGap ${fmtH(r.maxGapMs / HOUR)} (want 19h)`
    );

    r = analyzeSchedules(["*/30 8-17 * * 1-5"], now);
    check(
        Math.abs(r.maxGapMs - 62.5 * HOUR) < MIN,
        `range+dow "*/30 8-17 * * 1-5" maxGap ${fmtH(r.maxGapMs / HOUR)} (want 62.5h)`
    );

    r = analyzeSchedules(["0 7-18 * * 1-5"], now);
    check(
        Math.abs(r.maxGapMs - 61 * HOUR) < MIN,
        `hour-range "0 7-18 * * 1-5" maxGap ${fmtH(r.maxGapMs / HOUR)} (want 61h)`
    );

    r = analyzeSchedules(["0 9 * * 5"], now);
    check(r.maxGapMs === 7 * DAY, `weekly "0 9 * * 5" maxGap ${fmtH(r.maxGapMs / HOUR)} (want 168h)`);

    r = analyzeSchedules(["25 */2 * * *"], now);
    check(r.maxGapMs === 2 * HOUR, `step-hour "25 */2 * * *" maxGap ${fmtH(r.maxGapMs / HOUR)} (want 2h)`);

    // Multi-expression union: ap-polling style.
    r = analyzeSchedules(["30 7 * * *", "0 12,17 * * *"], now);
    check(
        r.maxGapMs === 14.5 * HOUR,
        `union maxGap ${fmtH(r.maxGapMs / HOUR)} (want 14.5h)`
    );

    if (fails > 0) {
        console.error(`selftest: ${fails} assertion(s) failed`);
        process.exit(1);
    }
    console.log("selftest: all assertions passed");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (process.argv[2] === "--selftest") {
        selftest();
        return;
    }

    const jobs = listJobs();
    console.log(
        `cron-coverage @ ${new Date(NOW_MS).toISOString()} — ` +
            `${jobs.length} registered jobs, Denver offset UTC-${OFFSET_MIN / 60}h`
    );
    console.log("");

    const rows: Array<{
        classification: string;
        name: string;
        ageH: number | null; // null = no run recorded
        maxGapH: number;
        schedule: string;
    }> = [];

    for (const job of jobs) {
        const schedules = Array.isArray(job.schedule) ? job.schedule : [job.schedule];
        const { fires, maxGapMs } = analyzeSchedules(schedules, NOW_MS);
        const maxGapH = maxGapMs / 3_600_000;

        let classification: string;
        let ageH: number | null = null;

        if (job.enabled === false) {
            classification = "DISABLED";
        } else {
            let lastRun: RunRow | null = null;
            try {
                lastRun = await fetchLastRun(job.name);
            } catch (err: any) {
                console.error(
                    `[cron-coverage] FATAL: cannot read cron_runs for "${job.name}": ` +
                        `${err?.message ?? err}`
                );
                console.error("  Is PostgREST up at localhost:5434?");
                process.exit(1);
            }
            if (lastRun) {
                ageH = (NOW_MS - Date.parse(lastRun.started_at)) / 3_600_000;
                classification = ageH <= 2 * maxGapH ? "OK" : "STALE";
            } else {
                const firstFire = fires.length > 0 ? fires[0] : Number.POSITIVE_INFINITY;
                const firstGapH = (firstFire - NOW_MS) / 3_600_000;
                classification =
                    firstGapH <= maxGapH ? "SPARSE-OK" : "STALE";
            }
        }

        rows.push({ classification, name: job.name, ageH, maxGapH, schedule: schedules.join(" | ") });
    }

    // Sorted: severity order (STALE first), then name.
    const order: Record<string, number> = { STALE: 0, "SPARSE-OK": 1, OK: 2, DISABLED: 3 };
    rows.sort((a, b) => order[a.classification] - order[b.classification] || a.name.localeCompare(b.name));

    const nameW = Math.max(4, ...rows.map((r) => r.name.length));

    const header =
        pad("CLASSIFICATION", 14) +
        pad("NAME", nameW + 2) +
        pad("LAST-RUN AGE (h)", 17) +
        pad("MAXGAP (h)", 12) +
        "SCHEDULE";
    console.log(header);
    console.log("-".repeat(Math.max(header.length, 90)));

    for (const r of rows) {
        const age = r.ageH === null ? (r.classification === "DISABLED" ? "-" : "n/a") : fmtH(r.ageH);
        console.log(
            pad(r.classification, 14) +
                pad(r.name, nameW + 2) +
                pad(age, 17) +
                pad(fmtH(r.maxGapH), 12) +
                r.schedule
        );
    }

    console.log("");
    const counts: Record<string, number> = { OK: 0, "SPARSE-OK": 0, DISABLED: 0, STALE: 0 };
    for (const r of rows) counts[r.classification]++;
    console.log(
        `SUMMARY  OK=${counts.OK}  SPARSE-OK=${counts["SPARSE-OK"]}  ` +
            `DISABLED=${counts.DISABLED}  STALE=${counts.STALE}  (total ${rows.length})`
    );

    // Detail lines for anything not plainly OK — makes the judgment auditable.
    for (const r of rows) {
        if (r.classification === "STALE") {
            console.log(
                `  ! ${r.name}: last run ${r.ageH === null ? "never" : fmtH(r.ageH) + " ago"} ` +
                    `vs 2*maxGap=${fmtH(2 * r.maxGapH)}`
            );
        } else if (r.classification === "SPARSE-OK") {
            console.log(
                `  ~ ${r.name}: no run in cron_runs; next fire within maxGap (${fmtH(r.maxGapH)}) — ` +
                    `retention may have pruned history`
            );
        }
    }

    process.exit(counts.STALE > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(`[cron-coverage] FATAL: ${err?.message ?? err}`);
    process.exit(1);
});
