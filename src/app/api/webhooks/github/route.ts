import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { GitHubClient } from "@/lib/github/client";

export async function POST(request: Request) {
    const signature = request.headers.get("x-hub-signature-256");
    const expectedSecret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!expectedSecret) {
        console.error("[SECURITY] GITHUB_WEBHOOK_SECRET not configured");
        return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
    }

    if (!signature || !signature.startsWith("sha256=")) {
        console.log("[SECURITY] Blocked webhook request without signature");
        return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }

    const rawBody = await request.text();
    const hmac = createHmac("sha256", expectedSecret).update(rawBody).digest("hex");
    const expectedSignature = `sha256=${hmac}`;

    const sigBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
        console.log("[SECURITY] Blocked webhook with invalid signature");
        return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    const body = JSON.parse(rawBody);
    const event = request.headers.get("x-github-event");

    const github = new GitHubClient();

    if (event === "pull_request" && body.action === "opened") {
        const results = await github.processPRDocuments(body.pull_request.number);
        if (results.length > 0) {
            await github.commentOnPR(body.pull_request.number, results.map(r => ({
                type: (r as any)?.classification?.type ?? "UNKNOWN",
                summary: (r as any)?.document?.action_summary ?? "Processed",
            })));
        }
    }

    if (event === "issues" && body.action === "closed") {
        const { createClient } = await import("@/lib/supabase");
        await createClient().from("documents")
            .update({ status: "ARCHIVED", github_issue_state: "closed" })
            .eq("github_issue_number", body.issue.number);
    }

    return new Response("ok");
}
