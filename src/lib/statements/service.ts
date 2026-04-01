import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

import { createClient } from "@/lib/supabase";
import { extractPDF } from "@/lib/pdf/extractor";
import { parseVendorStatement } from "@/lib/pdf/statement-parser";

import { reconcileStatementAgainstInvoices } from "./reconciliation";
import type {
    ArchivedVendorInvoice,
    NormalizedStatement,
    StatementIntakeRecord,
    StatementReconciliationRunRecord,
    StatementReconciliationRunSummary,
} from "./types";
import {
    archiveFedexCsvToAria,
    findLatestFedexCsvCandidate,
} from "./fedex-acquisition";

const execAsync = promisify(exec);

function emptySummary(): StatementReconciliationRunSummary {
    return {
        matchedCount: 0,
        missingCount: 0,
        mismatchCount: 0,
        duplicateCount: 0,
        needsReviewCount: 0,
        confidence: "medium",
    };
}

function mapIntakeRow(row: any): StatementIntakeRecord {
    return {
        id: row.id,
        vendorName: row.vendor_name,
        sourceType: row.source_type,
        sourceRef: row.source_ref,
        artifactPath: row.artifact_path,
        artifactKind: row.artifact_kind,
        statementDate: row.statement_date,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        status: row.status,
        adapterKey: row.adapter_key,
        fingerprint: row.fingerprint,
        rawMetadata: row.raw_metadata ?? {},
        discoveredAt: row.discovered_at ?? row.created_at,
        queuedBy: row.queued_by,
        lastError: row.last_error ?? null,
    };
}

function mapRunRow(row: any): StatementReconciliationRunRecord {
    return {
        id: row.id,
        intakeId: row.intake_id,
        vendorName: row.vendor_name,
        adapterKey: row.adapter_key,
        runStatus: row.run_status,
        triggerSource: row.trigger_source,
        startedAt: row.started_at ?? null,
        finishedAt: row.finished_at ?? null,
        summary: row.summary_json ?? emptySummary(),
        normalizedStatement: row.normalized_statement_json ?? null,
        results: row.results_json ?? null,
        matchedCount: row.matched_count ?? 0,
        missingCount: row.missing_count ?? 0,
        mismatchCount: row.mismatch_count ?? 0,
        duplicateCount: row.duplicate_count ?? 0,
        needsReviewCount: row.needs_review_count ?? 0,
        lastError: row.last_error ?? null,
        createdAt: row.created_at,
    };
}

export async function listStatementDashboardData() {
    const supabase = createClient();
    if (!supabase) {
        return { queue: [], runs: [], cachedAt: new Date().toISOString() };
    }

    const [{ data: intakeRows }, { data: runRows }] = await Promise.all([
        supabase
            .from("statement_intake_queue")
            .select("*")
            .order("discovered_at", { ascending: false })
            .limit(50),
        supabase
            .from("statement_reconciliation_runs")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(50),
    ]);

    return {
        queue: (intakeRows ?? []).map(mapIntakeRow),
        runs: (runRows ?? []).map(mapRunRow),
        cachedAt: new Date().toISOString(),
    };
}

export async function launchStatementRun(intakeId: string, triggerSource: string) {
    const supabase = createClient();
    if (!supabase) throw new Error("Supabase not configured");

    const { data: existing } = await supabase
        .from("statement_reconciliation_runs")
        .select("id")
        .eq("intake_id", intakeId)
        .in("run_status", ["queued", "processing"])
        .maybeSingle();

    if (existing?.id) {
        return { runId: existing.id as string, intakeId };
    }

    const { data: intakeRow, error: intakeError } = await supabase
        .from("statement_intake_queue")
        .select("*")
        .eq("id", intakeId)
        .single();

    if (intakeError || !intakeRow) {
        throw new Error("Statement intake not found");
    }

    const { data, error } = await supabase
        .from("statement_reconciliation_runs")
        .insert({
            intake_id: intakeId,
            vendor_name: intakeRow.vendor_name,
            adapter_key: intakeRow.adapter_key,
            run_status: "queued",
            trigger_source: triggerSource,
            summary_json: emptySummary(),
        })
        .select("id")
        .single();

    if (error) throw new Error(`Statement run launch failed: ${error.message}`);
    return { runId: data.id as string, intakeId };
}

export async function launchFedexDownloadRun(triggerSource: string) {
    const supabase = createClient();
    if (!supabase) throw new Error("Supabase not configured");

    const periodEnd = new Date().toISOString().split("T")[0];
    const periodStart = `${periodEnd.slice(0, 8)}01`;
    const fingerprint = `fedex_download::fedex::dashboard-launch::${periodStart}::${periodEnd}`;

    const { data: existing } = await supabase
        .from("statement_intake_queue")
        .select("id")
        .eq("fingerprint", fingerprint)
        .maybeSingle();

    let intakeId = existing?.id as string | undefined;
    if (!intakeId) {
        const { data, error } = await supabase
            .from("statement_intake_queue")
            .insert({
                vendor_name: "FedEx",
                source_type: "download_statement",
                source_ref: "dashboard-fedex-download",
                artifact_path: null,
                artifact_kind: "csv",
                statement_date: periodEnd,
                period_start: periodStart,
                period_end: periodEnd,
                status: "ready",
                adapter_key: "fedex_download",
                fingerprint,
                raw_metadata: {
                    requestedBy: triggerSource,
                },
                discovered_at: new Date().toISOString(),
                queued_by: "dashboard",
            })
            .select("id")
            .single();

        if (error) throw new Error(`FedEx intake launch failed: ${error.message}`);
        intakeId = data.id as string;
    }

    return launchStatementRun(intakeId, triggerSource);
}

function parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of line) {
        if (ch === "\"") inQuotes = !inQuotes;
        else if (ch === "," && !inQuotes) {
            fields.push(current.trim());
            current = "";
        } else current += ch;
    }
    fields.push(current.trim());
    return fields;
}

async function readArtifact(bucket: string, artifactPath: string): Promise<Buffer> {
    const supabase = createClient();
    if (!supabase) throw new Error("Supabase not configured");
    const { data, error } = await supabase.storage.from(bucket).download(artifactPath);
    if (error || !data) throw new Error(`Artifact download failed: ${error?.message ?? "missing artifact"}`);
    return Buffer.from(await data.arrayBuffer());
}

async function materializeFedexArtifact(intake: StatementIntakeRecord): Promise<StatementIntakeRecord> {
    const supabase = createClient();
    if (!supabase) throw new Error("Supabase not configured");

    let candidate = findLatestFedexCsvCandidate();
    let localCsv = candidate?.fullPath ?? null;
    let acquisitionMetadata: Record<string, unknown> = candidate
        ? {
            acquisitionMode: "existing_file",
            acquisitionSource: candidate.source,
            sourcePath: candidate.fullPath,
        }
        : {};

    if (!localCsv) {
        const { stdout } = await execAsync("node --import tsx src/cli/fetch-fedex-csv.ts --json", {
            cwd: process.cwd(),
            timeout: 10 * 60 * 1000,
            maxBuffer: 10 * 1024 * 1024,
        });
        const lastJsonLine = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .reverse()
            .find((line) => line.startsWith("{") && line.endsWith("}"));

        if (lastJsonLine) {
            const parsed = JSON.parse(lastJsonLine) as Record<string, unknown>;
            if (parsed.savedPath && typeof parsed.savedPath === "string") {
                localCsv = parsed.savedPath;
            }
            acquisitionMetadata = {
                acquisitionMode: parsed.mode ?? "playwright_download",
                acquisitionState: parsed.detectedState ?? null,
                sourcePath: parsed.sourcePath ?? null,
                savedPath: parsed.savedPath ?? null,
                acquisitionMessage: parsed.message ?? null,
            };
        }

        if (!localCsv) {
            candidate = findLatestFedexCsvCandidate();
            localCsv = candidate?.fullPath ?? null;
        }
    }

    if (!localCsv) {
        throw new Error("FedEx CSV download did not produce a statement artifact.");
    }

    const stableCsvPath = archiveFedexCsvToAria(localCsv);
    const artifactPath = `fedex/${Date.now()}_${path.basename(stableCsvPath)}`;
    const { error: uploadError } = await supabase.storage
        .from("statement_artifacts")
        .upload(artifactPath, await readArtifactFile(stableCsvPath), {
            contentType: "text/csv",
            upsert: true,
        });

    if (uploadError) {
        throw new Error(`FedEx CSV upload failed: ${uploadError.message}`);
    }

    await supabase.from("statement_intake_queue").update({
        artifact_path: artifactPath,
        artifact_kind: "csv",
        raw_metadata: {
            ...(intake.rawMetadata ?? {}),
            ...acquisitionMetadata,
            stableCsvPath,
        },
        updated_at: new Date().toISOString(),
    }).eq("id", intake.id);

    return {
        ...intake,
        artifactPath,
        artifactKind: "csv",
        rawMetadata: {
            ...(intake.rawMetadata ?? {}),
            ...acquisitionMetadata,
            stableCsvPath,
        },
    };
}

async function readArtifactFile(filePath: string): Promise<Buffer> {
    const fs = await import("fs");
    return fs.readFileSync(filePath);
}

function normalizeFedexCsv(csv: string, intake: StatementIntakeRecord): NormalizedStatement {
    const rows = csv.split(/\r?\n/).filter(Boolean);
    const headers = rows[0].replace(/"/g, "").split(",");
    const col = (name: string) => headers.indexOf(name);

    const lines = rows.slice(1)
        .map((row) => parseCsvLine(row))
        .filter((fields) => fields[col("TEMPLATE_TYPE")] === "INVHDR")
        .map((fields) => {
            const shipDate = fields[col("SHIP_DATE")] || "";
            const match = shipDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
            const amount = parseFloat((fields[col("AMT_DUE")] || "0").replace(/,/g, ""));
            return {
                referenceNumber: fields[col("INVOICE_NUMBER")] || "",
                documentType: "invoice" as const,
                date: match ? `${match[3]}-${match[1]}-${match[2]}` : intake.statementDate ?? new Date().toISOString().split("T")[0],
                amount,
                balance: amount,
                poNumber: (fields[col("PO_NUMBER")] || fields[col("REF_NUM")] || "").match(/\b(\d{6})\b/)?.[1] ?? null,
                trackingNumber: fields[col("INVOICE_NUMBER")] || null,
                notes: fields[col("TERMS")] || null,
            };
        });

    const totalCharges = lines.reduce((sum, line) => sum + line.amount, 0);

    return {
        vendorName: "FedEx",
        statementDate: intake.statementDate ?? new Date().toISOString().split("T")[0],
        periodStart: intake.periodStart,
        periodEnd: intake.periodEnd,
        accountNumber: null,
        totals: {
            openingBalance: 0,
            totalCharges,
            totalCredits: 0,
            endingBalance: totalCharges,
        },
        lines,
        sourceMeta: {
            adapterKey: intake.adapterKey,
            sourceRef: intake.sourceRef,
            artifactPath: intake.artifactPath,
            filename: intake.artifactPath ? path.basename(intake.artifactPath) : null,
        },
    };
}

function mapParsedStatement(parsed: any, intake: StatementIntakeRecord): NormalizedStatement {
    return {
        vendorName: parsed.vendorName,
        statementDate: parsed.statementDate,
        periodStart: parsed.periodStart ?? null,
        periodEnd: parsed.periodEnd ?? null,
        accountNumber: parsed.accountNumber ?? null,
        totals: {
            openingBalance: parsed.openingBalance ?? null,
            totalCharges: parsed.totalCharges ?? null,
            totalCredits: parsed.totalCredits ?? null,
            endingBalance: parsed.endingBalance ?? null,
        },
        lines: (parsed.lines ?? []).map((line: any) => ({
            referenceNumber: line.referenceNumber,
            documentType: line.documentType,
            date: line.date,
            amount: line.charges ?? line.credits ?? 0,
            balance: line.balance ?? 0,
            notes: line.description ?? null,
        })),
        sourceMeta: {
            adapterKey: intake.adapterKey,
            sourceRef: intake.sourceRef,
            artifactPath: intake.artifactPath,
        },
    };
}

async function normalizeIntake(intake: StatementIntakeRecord): Promise<NormalizedStatement> {
    if (intake.adapterKey === "fedex_download") {
        const readyIntake = intake.artifactPath ? intake : await materializeFedexArtifact(intake);
        const csvBuffer = await readArtifact("statement_artifacts", readyIntake.artifactPath!);
        return normalizeFedexCsv(csvBuffer.toString("utf8"), readyIntake);
    }

    if (!intake.artifactPath) {
        throw new Error("Statement intake has no artifact to reconcile.");
    }

    const pdfBuffer = await readArtifact("statement_artifacts", intake.artifactPath);
    const extracted = await extractPDF(pdfBuffer);
    const parsed = await parseVendorStatement(extracted.rawText);
    return mapParsedStatement(parsed, intake);
}

async function fetchArchivedInvoices(intake: StatementIntakeRecord): Promise<ArchivedVendorInvoice[]> {
    const supabase = createClient();
    if (!supabase) throw new Error("Supabase not configured");

    let query = supabase
        .from("vendor_invoices")
        .select("id, vendor_name, invoice_number, invoice_date, po_number, total")
        .ilike("vendor_name", `%${intake.vendorName}%`)
        .order("invoice_date", { ascending: false })
        .limit(500);

    if (intake.periodStart) query = query.gte("invoice_date", intake.periodStart);
    if (intake.periodEnd) query = query.lte("invoice_date", intake.periodEnd);

    const { data, error } = await query;
    if (error) throw new Error(`Vendor invoice lookup failed: ${error.message}`);
    return (data ?? []) as ArchivedVendorInvoice[];
}

export async function processQueuedStatementRun(notify?: (message: string) => Promise<void>) {
    const supabase = createClient();
    if (!supabase) return null;

    const { data: runRow } = await supabase
        .from("statement_reconciliation_runs")
        .select("*")
        .eq("run_status", "queued")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

    if (!runRow) return null;

    const run = mapRunRow(runRow);
    const { data: intakeRow, error: intakeError } = await supabase
        .from("statement_intake_queue")
        .select("*")
        .eq("id", run.intakeId)
        .single();

    if (intakeError || !intakeRow) {
        await supabase.from("statement_reconciliation_runs").update({
            run_status: "error",
            last_error: "Statement intake row missing.",
            finished_at: new Date().toISOString(),
        }).eq("id", run.id);
        return null;
    }

    const intake = mapIntakeRow(intakeRow);
    await supabase.from("statement_reconciliation_runs").update({
        run_status: "processing",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }).eq("id", run.id);
    await supabase.from("statement_intake_queue").update({
        status: "processing",
        updated_at: new Date().toISOString(),
    }).eq("id", intake.id);

    try {
        const normalized = await normalizeIntake(intake);
        const archived = await fetchArchivedInvoices(intake);
        const reconciliation = reconcileStatementAgainstInvoices(normalized, archived);
        const finalStatus = reconciliation.summary.missingCount === 0
            && reconciliation.summary.mismatchCount === 0
            && reconciliation.summary.needsReviewCount === 0
            && reconciliation.summary.duplicateCount === 0
            ? "completed"
            : "needs_review";

        await supabase.from("statement_reconciliation_runs").update({
            run_status: finalStatus,
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            summary_json: reconciliation.summary,
            normalized_statement_json: normalized,
            results_json: reconciliation.lines,
            matched_count: reconciliation.summary.matchedCount,
            missing_count: reconciliation.summary.missingCount,
            mismatch_count: reconciliation.summary.mismatchCount,
            duplicate_count: reconciliation.summary.duplicateCount,
            needs_review_count: reconciliation.summary.needsReviewCount,
            last_error: null,
        }).eq("id", run.id);

        await supabase.from("statement_intake_queue").update({
            status: finalStatus === "completed" ? "reconciled" : "needs_review",
            updated_at: new Date().toISOString(),
            last_error: null,
        }).eq("id", intake.id);

        if (notify) {
            await notify(
                `Statement run complete: ${intake.vendorName}\n` +
                `matched=${reconciliation.summary.matchedCount} ` +
                `missing=${reconciliation.summary.missingCount} ` +
                `mismatch=${reconciliation.summary.mismatchCount} ` +
                `review=${reconciliation.summary.needsReviewCount + reconciliation.summary.duplicateCount}`,
            );
        }

        return {
            runId: run.id,
            intakeId: intake.id,
            status: finalStatus,
        };
    } catch (error: any) {
        await supabase.from("statement_reconciliation_runs").update({
            run_status: "error",
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            last_error: error.message,
        }).eq("id", run.id);
        await supabase.from("statement_intake_queue").update({
            status: "error",
            updated_at: new Date().toISOString(),
            last_error: error.message,
        }).eq("id", intake.id);
        if (notify) await notify(`Statement run failed: ${intake.vendorName}\n${error.message}`);
        return null;
    }
}
