#!/usr/bin/env node
/**
 * Run from a GitHub Actions step that triggers on workflow failure.
 * Inserts a `ci_failure` row into agent_task via Supabase REST.
 *
 * Required env (set by GitHub + repo secrets):
 *   NEXT_PUBLIC_SUPABASE_URL  — e.g. https://abc.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — from repo secrets
 *   GITHUB_REPOSITORY         — auto-set (owner/repo)
 *   GITHUB_RUN_ID             — auto-set (numeric)
 *   GITHUB_WORKFLOW           — auto-set ("CI")
 *   GITHUB_REF_NAME           — auto-set (branch name)
 *   GITHUB_SHA                — auto-set (commit)
 *
 * Optional:
 *   GITHUB_RUN_NUMBER, GITHUB_JOB, FAILED_STEP — improve task detail
 *
 * The row dedups via the (source_table, source_id, input_hash) partial
 * unique index on agent_task: re-running the same workflow at the same
 * sha bumps dedup_count instead of creating a new row.
 */

import { createHash } from "node:crypto";

const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_WORKFLOW",
    "GITHUB_REF_NAME",
    "GITHUB_SHA",
];
for (const k of required) {
    if (!process.env[k]) {
        console.error(`report-ci-failure: missing required env ${k}`);
        process.exit(1);
    }
}

const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/agent_task`;
const sourceId = `${process.env.GITHUB_REPOSITORY}#${process.env.GITHUB_RUN_ID}`;
const sha = process.env.GITHUB_SHA;
const goal = `CI failed: ${process.env.GITHUB_WORKFLOW} on ${process.env.GITHUB_REF_NAME} (${sha.slice(0, 7)})`;

const inputs = {
    repo: process.env.GITHUB_REPOSITORY,
    workflow: process.env.GITHUB_WORKFLOW,
    runId: process.env.GITHUB_RUN_ID,
    runNumber: process.env.GITHUB_RUN_NUMBER ?? null,
    ref: process.env.GITHUB_REF_NAME,
    sha,
    job: process.env.GITHUB_JOB ?? null,
    failedStep: process.env.FAILED_STEP ?? null,
    runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
};

// Stable hash so retries of the same workflow+ref+sha dedup. Don't include
// runId — that's the discriminator we want to fold over.
const canonical = JSON.stringify({
    repo: inputs.repo,
    workflow: inputs.workflow,
    ref: inputs.ref,
    sha: inputs.sha,
});
const inputHash = createHash("sha256").update(canonical).digest("hex");

const closesWhen = {
    kind: "ci_workflow_passes",
    workflow: process.env.GITHUB_WORKFLOW,
    ref: process.env.GITHUB_REF_NAME,
};

const body = {
    type: "ci_failure",
    source_table: "github_actions",
    source_id: sourceId,
    input_hash: inputHash,
    goal,
    status: "PENDING",
    owner: "aria",
    priority: 1,
    requires_approval: false,
    inputs,
    closes_when: closesWhen,
    dedup_count: 1,
};

const res = await fetch(url, {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation",
        "apikey": process.env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(body),
});

if (!res.ok) {
    const text = await res.text();
    console.error(`report-ci-failure: ${res.status} ${res.statusText} — ${text}`);
    process.exit(1);
}

console.log(`report-ci-failure: surfaced run ${process.env.GITHUB_RUN_ID} as agent_task`);
