import { Octokit } from "@octokit/rest";
import { createClient } from "@/lib/supabase";
import Anthropic from "@anthropic-ai/sdk";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const anthropic = new Anthropic();

const GITHUB_OWNER = process.env.GITHUB_OWNER!;
const GITHUB_REPO = process.env.GITHUB_REPO!;

export class GitHubClient {

    // Create a GitHub issue from a document discrepancy or action item
    async createIssueFromDocument(doc: {
        type: string;
        vendorName: string;
        invoiceNumber?: string;
        actionSummary: string;
        discrepancies?: Array<{ field: string; delta?: number; severity: string }>;
        documentId: string;
    }) {
        const labels = this.getLabelsForDocType(doc.type);
        const body = this.formatIssueBody(doc);

        const issue = await octokit.issues.create({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            title: `[${doc.type}] ${doc.vendorName}${doc.invoiceNumber ? ` — ${doc.invoiceNumber}` : ""}: ${doc.actionSummary.slice(0, 80)}`,
            body,
            labels,
        });

        // Store link in Supabase
        await createClient().from("documents").update({
            github_issue_number: issue.data.number,
            github_issue_url: issue.data.html_url,
        }).eq("id", doc.documentId);

        return issue.data;
    }

    // Sync open issues related to documents
    async syncDocumentIssues() {
        const supabase = createClient();

        const issues = await octokit.issues.listForRepo({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            labels: "aria-document",
            state: "open",
        });

        await Promise.all(issues.data.map(async (issue) => {
            // Extract document ID from issue body
            const docIdMatch = issue.body?.match(/Document ID: `([^`]+)`/);
            if (!docIdMatch) return;

            await supabase.from("documents").update({
                github_issue_state: issue.state,
                github_last_synced: new Date().toISOString(),
            }).eq("id", docIdMatch[1]);
        }));

        return issues.data.length;
    }

    // Watch PR for uploaded document files (e.g., POs committed to repo)
    async processPRDocuments(prNumber: number) {
        const files = await octokit.pulls.listFiles({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            pull_number: prNumber,
        });

        const pdfFiles = files.data.filter(f =>
            f.filename.endsWith(".pdf") &&
            f.status !== "removed"
        );

        const processed = await Promise.all(pdfFiles.map(async (file) => {
            // Download the file content
            const { data } = await octokit.repos.getContent({
                owner: GITHUB_OWNER,
                repo: GITHUB_REPO,
                path: file.filename,
                ref: file.sha,
            });

            if ("content" in data && typeof data.content === "string") {
                const buffer = Buffer.from(data.content, "base64");
                const { processDocument } = await import("@/lib/gmail/attachment-handler");
                return processDocument(buffer, {
                    filename: file.filename,
                    mimeType: "application/pdf",
                    source: "github",
                    sourceRef: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/pull/${prNumber}`,
                });
            }
        }));

        return processed.filter(Boolean);
    }

    // Create a comment on PR with document extraction results
    async commentOnPR(prNumber: number, extractionResults: Array<{ type: string; summary: string }>) {
        const body = [
            "## 📄 ARIA Document Analysis",
            "",
            "| Document | Type | Status |",
            "|---|---|---|",
            ...extractionResults.map(r => `| ${r.summary} | ${r.type} | ✅ Processed |`),
            "",
            "_Processed by ARIA Document Intelligence_",
        ].join("\n");

        await octokit.issues.createComment({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            issue_number: prNumber,
            body,
        });
    }

    // Summarize repo activity — issues, PRs, and linked documents
    async getRepoDigest(days: number = 7) {
        const since = new Date(Date.now() - days * 86400000).toISOString();

        const [issues, prs, commits] = await Promise.all([
            octokit.issues.listForRepo({ owner: GITHUB_OWNER, repo: GITHUB_REPO, state: "open", since }),
            octokit.pulls.list({ owner: GITHUB_OWNER, repo: GITHUB_REPO, state: "open" }),
            octokit.repos.listCommits({ owner: GITHUB_OWNER, repo: GITHUB_REPO, since, per_page: 20 }),
        ]);

        const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            messages: [{
                role: "user",
                content: `Summarize this GitHub repository activity for the last ${days} days.
Focus on: open issues needing attention, PRs ready for review, recent changes.
Be concise — bullet points for each category.

Issues: ${JSON.stringify(issues.data.slice(0, 10).map(i => ({ title: i.title, labels: i.labels.map(l => typeof l === "object" ? l.name : l) })))}
PRs: ${JSON.stringify(prs.data.slice(0, 5).map(p => ({ title: p.title, state: p.state, draft: p.draft })))}
Commits: ${JSON.stringify(commits.data.slice(0, 10).map(c => c.commit.message.split("\n")[0]))}`,
            }],
        });

        return response.content[0].type === "text" ? response.content[0].text : "";
    }

    private getLabelsForDocType(type: string): string[] {
        const base = ["aria-document"];
        const map: Record<string, string[]> = {
            INVOICE: ["invoice", "accounts-payable"],
            PURCHASE_ORDER: ["purchase-order"],
            VENDOR_STATEMENT: ["vendor-statement", "reconciliation"],
            BILL_OF_LADING: ["logistics", "shipping"],
            DISCREPANCY: ["discrepancy", "needs-review"],
        };
        return [...base, ...(map[type] ?? [])];
    }

    private formatIssueBody(doc: {
        type: string;
        vendorName: string;
        invoiceNumber?: string;
        actionSummary: string;
        discrepancies?: Array<{ field: string; delta?: number; severity: string }>;
        documentId: string;
    }): string {
        const lines = [
            `## ${doc.type}: ${doc.vendorName}`,
            "",
            doc.actionSummary,
            "",
        ];

        if (doc.discrepancies?.length) {
            lines.push("## Discrepancies", "");
            lines.push("| Field | Delta | Severity |");
            lines.push("|---|---|---|");
            for (const d of doc.discrepancies) {
                const delta = d.delta != null ? `$${d.delta.toFixed(2)}` : "—";
                lines.push(`| ${d.field} | ${delta} | ${d.severity} |`);
            }
            lines.push("");
        }

        lines.push(`---`);
        lines.push(`Document ID: \`${doc.documentId}\``);
        lines.push(`_Auto-created by ARIA at ${new Date().toISOString()}_`);

        return lines.join("\n");
    }
}
