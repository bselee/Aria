import { GitHubClient } from "@/lib/github/client";
import { verifyGithubSignature } from "@/lib/security/access";

export async function POST(req: Request) {
    // Read the raw body once — signature verification must run against the exact
    // bytes GitHub signed, so we cannot use req.json() before verifying.
    const rawBody = await req.text();
    const signature = req.headers.get("x-hub-signature-256");
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (!secret) {
        // Fail closed: an unauthenticated webhook can archive documents and
        // kick off PR processing, so we refuse to act until a secret is set.
        console.error(
            "[webhook/github] GITHUB_WEBHOOK_SECRET is not configured — rejecting webhook.",
        );
        return new Response("webhook not configured", { status: 503 });
    }

    if (!verifyGithubSignature(rawBody, signature, secret)) {
        console.warn("[webhook/github] Rejected webhook with invalid/missing signature.");
        return new Response("invalid signature", { status: 401 });
    }

    let body: any;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return new Response("invalid payload", { status: 400 });
    }

    const event = req.headers.get("x-github-event");
    const github = new GitHubClient();

    if (event === "pull_request" && body.action === "opened") {
        // Process any PDF files in the new PR
        const results = await github.processPRDocuments(body.pull_request.number);
        if (results.length > 0) {
            await github.commentOnPR(body.pull_request.number, results.map(r => ({
                type: (r as any)?.classification?.type ?? "UNKNOWN",
                summary: (r as any)?.document?.action_summary ?? "Processed",
            })));
        }
    }

    if (event === "issues" && body.action === "closed") {
        // Mark linked document as resolved in Supabase
        const { createClient } = await import("@/lib/supabase");
        await createClient().from("documents")
            .update({ status: "ARCHIVED", github_issue_state: "closed" })
            .eq("github_issue_number", body.issue.number);
    }

    return new Response("ok");
}
