import { GitHubClient } from "@/lib/github/client";

export async function POST(req: Request) {
    const body = await req.json();
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
