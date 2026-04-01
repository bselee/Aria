import { createHash } from "crypto";

import { createClient } from "@/lib/supabase";

export function buildStatementFingerprint(args: {
    adapterKey: string;
    vendorName: string;
    sourceRef: string;
    periodStart?: string | null;
    periodEnd?: string | null;
}): string {
    return [
        args.adapterKey,
        args.vendorName.trim().toLowerCase(),
        args.sourceRef.trim().toLowerCase(),
        args.periodStart ?? "",
        args.periodEnd ?? "",
    ].join("::");
}

export async function queueStatementEmailIntake(args: {
    gmailMessageId: string;
    sourceInbox: string;
    vendorName: string;
    emailFrom: string;
    emailSubject: string;
    filename: string;
    contentType: string;
    buffer: Buffer;
    statementDate?: string | null;
    periodStart?: string | null;
    periodEnd?: string | null;
}): Promise<string | null> {
    const supabase = createClient();
    if (!supabase) return null;

    const fingerprint = buildStatementFingerprint({
        adapterKey: "email_statement",
        vendorName: args.vendorName,
        sourceRef: args.gmailMessageId,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
    });

    const { data: existing } = await supabase
        .from("statement_intake_queue")
        .select("id")
        .eq("fingerprint", fingerprint)
        .maybeSingle();

    if (existing?.id) {
        return existing.id as string;
    }

    const artifactPath = `${args.gmailMessageId}/${Date.now()}_${args.filename}`;
    const { error: uploadError } = await supabase.storage
        .from("statement_artifacts")
        .upload(artifactPath, args.buffer, {
            contentType: args.contentType,
            upsert: true,
        });

    if (uploadError) {
        throw new Error(`Statement artifact upload failed: ${uploadError.message}`);
    }

    const { data, error } = await supabase
        .from("statement_intake_queue")
        .insert({
            vendor_name: args.vendorName,
            source_type: "email_statement",
            source_ref: args.gmailMessageId,
            artifact_path: artifactPath,
            artifact_kind: "pdf",
            statement_date: args.statementDate ?? null,
            period_start: args.periodStart ?? null,
            period_end: args.periodEnd ?? null,
            status: "ready",
            adapter_key: "email_statement",
            fingerprint,
            raw_metadata: {
                emailFrom: args.emailFrom,
                emailSubject: args.emailSubject,
                sourceInbox: args.sourceInbox,
                filename: args.filename,
                contentHash: createHash("sha256").update(args.buffer).digest("hex"),
            },
            discovered_at: new Date().toISOString(),
            queued_by: "ap_identifier",
        })
        .select("id");

    if (error) {
        throw new Error(`Statement intake insert failed: ${error.message}`);
    }

    return data?.[0]?.id ?? null;
}

export async function queueStatementMetadataOnly(args: {
    gmailMessageId: string;
    sourceInbox: string;
    vendorName: string;
    emailFrom: string;
    emailSubject: string;
}): Promise<string | null> {
    const supabase = createClient();
    if (!supabase) return null;

    const today = new Date().toISOString().split("T")[0];
    const fingerprint = buildStatementFingerprint({
        adapterKey: "email_statement",
        vendorName: args.vendorName,
        sourceRef: args.gmailMessageId,
        periodStart: today,
        periodEnd: today,
    });

    const { data: existing } = await supabase
        .from("statement_intake_queue")
        .select("id")
        .eq("fingerprint", fingerprint)
        .maybeSingle();

    if (existing?.id) return existing.id as string;

    const { data, error } = await supabase
        .from("statement_intake_queue")
        .insert({
            vendor_name: args.vendorName,
            source_type: "email_statement",
            source_ref: args.gmailMessageId,
            artifact_path: null,
            artifact_kind: "none",
            statement_date: today,
            period_start: today,
            period_end: today,
            status: "needs_review",
            adapter_key: "email_statement",
            fingerprint,
            raw_metadata: {
                emailFrom: args.emailFrom,
                emailSubject: args.emailSubject,
                sourceInbox: args.sourceInbox,
                missingArtifact: true,
            },
            discovered_at: new Date().toISOString(),
            queued_by: "ap_identifier",
        })
        .select("id");

    if (error) {
        throw new Error(`Statement metadata intake insert failed: ${error.message}`);
    }

    return data?.[0]?.id ?? null;
}
