/**
 * @file    catalog.ts
 * @purpose Reads the live `.agents/**` directory tree and the hardcoded v1
 *          agent hierarchy and produces a single CommandBoardCatalog object
 *          consumed by the dashboard. No caching — the directory is small.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
    CommandBoardAgent,
    CommandBoardCatalog,
    CommandBoardCatalogFile,
    CommandBoardReference,
    CommandBoardSkill,
    CommandBoardWorkflow,
} from "./types";

// ── Hierarchy v1 (hardcoded) ────────────────────────────────────────────────

const HIERARCHY: CommandBoardAgent[] = [
    { id: "will", label: "Will", reportsTo: null, process: [], skills: [], workflows: [] },
    { id: "ops-manager", label: "Ops Manager", reportsTo: "will", process: ["aria-bot"], skills: [], workflows: [] },
    { id: "aria-bot", label: "Aria Bot", reportsTo: "ops-manager", process: ["aria-bot"], skills: [], workflows: [] },
    { id: "ap-agent", label: "AP Agent", reportsTo: "ops-manager", process: ["aria-bot"], skills: [], workflows: [] },
    { id: "watchdog", label: "Slack Watchdog", reportsTo: "ops-manager", process: ["aria-bot"], skills: [], workflows: [] },
    { id: "supervisor", label: "Supervisor", reportsTo: "ops-manager", process: ["aria-bot"], skills: [], workflows: [] },
    { id: "reconciliation", label: "Reconciliation", reportsTo: "ops-manager", process: ["aria-bot"], skills: [], workflows: [] },
    { id: "purchasing", label: "Purchasing", reportsTo: "ops-manager", process: ["aria-bot"], skills: [], workflows: [] },
    { id: "tracking", label: "Tracking", reportsTo: "ops-manager", process: ["aria-bot"], skills: [], workflows: [] },
    { id: "build-risk", label: "Build Risk", reportsTo: "ops-manager", process: ["aria-bot"], skills: [], workflows: [] },
    { id: "nightshift", label: "Nightshift", reportsTo: "ops-manager", process: ["nightshift-runner"], skills: [], workflows: [] },
    { id: "vendor-intelligence", label: "Vendor Intelligence", reportsTo: "ops-manager", process: ["aria-bot"], skills: [], workflows: [] },
];

// ── Markdown summary helper ─────────────────────────────────────────────────

const MAX_SUMMARY = 200;

/**
 * Pull the first non-empty paragraph from a markdown body, skipping the H1
 * if present. Truncates to ~200 chars + ellipsis.
 */
export function summarizeMarkdown(raw: string): string {
    if (!raw) return "";
    const lines = raw.split(/\r?\n/);

    // Skip leading H1 line if present.
    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i < lines.length && /^#\s+/.test(lines[i])) i++;

    // Walk paragraphs (separated by blank lines).
    const paragraphs: string[] = [];
    let buf: string[] = [];
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "") {
            if (buf.length) {
                paragraphs.push(buf.join(" ").trim());
                buf = [];
            }
        } else {
            buf.push(line.trim());
        }
        if (paragraphs.length > 0) break;
    }
    if (paragraphs.length === 0 && buf.length) {
        paragraphs.push(buf.join(" ").trim());
    }

    let summary = (paragraphs[0] ?? "").trim();
    if (!summary) return "";

    // Strip leading markdown markers like '> ', '* ', '- '.
    summary = summary.replace(/^[>\-*]\s+/, "");

    if (summary.length > MAX_SUMMARY) {
        summary = summary.slice(0, MAX_SUMMARY) + "...";
    }
    return summary;
}

// ── File reading ────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const AGENTS_ROOT = path.join(ROOT, ".agents");

async function readFileSafe(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, "utf8");
    } catch {
        return null;
    }
}

async function listMd(dir: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries
            .filter((e) => e.isFile() && e.name.endsWith(".md"))
            .map((e) => path.join(dir, e.name));
    } catch {
        return [];
    }
}

async function listSkillDirs(dir: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
    } catch {
        return [];
    }
}

function fileBaseId(filePath: string): string {
    return path.basename(filePath).replace(/\.md$/i, "");
}

function relativePath(absPath: string): string {
    return path.relative(ROOT, absPath).split(path.sep).join("/");
}

async function readAgentFiles(): Promise<CommandBoardCatalogFile[]> {
    const files = await listMd(path.join(AGENTS_ROOT, "agents"));
    const out: CommandBoardCatalogFile[] = [];
    for (const f of files) {
        const raw = (await readFileSafe(f)) ?? "";
        out.push({
            id: fileBaseId(f),
            name: fileBaseId(f),
            path: relativePath(f),
            summary: summarizeMarkdown(raw),
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function readSkills(): Promise<CommandBoardSkill[]> {
    const dirs = await listSkillDirs(path.join(AGENTS_ROOT, "skills"));
    const out: CommandBoardSkill[] = [];
    for (const dir of dirs) {
        const skillFile = path.join(dir, "SKILL.md");
        const raw = (await readFileSafe(skillFile)) ?? "";
        if (!raw) continue;
        const id = path.basename(dir);
        out.push({
            id,
            name: id,
            path: relativePath(skillFile),
            description: summarizeMarkdown(raw),
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function readWorkflows(): Promise<CommandBoardWorkflow[]> {
    const files = await listMd(path.join(AGENTS_ROOT, "workflows"));
    const out: CommandBoardWorkflow[] = [];
    for (const f of files) {
        const raw = (await readFileSafe(f)) ?? "";
        out.push({
            id: fileBaseId(f),
            name: fileBaseId(f),
            path: relativePath(f),
            description: summarizeMarkdown(raw),
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function readReferences(): Promise<CommandBoardReference[]> {
    const out: CommandBoardReference[] = [];
    const agentsMd = path.join(AGENTS_ROOT, "AGENTS.md");
    const raw = await readFileSafe(agentsMd);
    if (raw !== null) {
        out.push({
            id: "AGENTS",
            name: "AGENTS",
            path: relativePath(agentsMd),
            summary: summarizeMarkdown(raw),
        });
    }
    return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function buildCatalog(): Promise<CommandBoardCatalog> {
    const [agentFiles, skills, workflows, references] = await Promise.all([
        readAgentFiles(),
        readSkills(),
        readWorkflows(),
        readReferences(),
    ]);
    return {
        generatedAt: new Date().toISOString(),
        agents: HIERARCHY.map((a) => ({ ...a })),
        agentFiles,
        skills,
        workflows,
        references,
    };
}

export const COMMAND_BOARD_HIERARCHY = HIERARCHY;
