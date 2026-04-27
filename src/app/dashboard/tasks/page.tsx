import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { TasksPanel } from "@/components/dashboard/TasksPanel";

export const metadata = {
    title: "Tasks · Aria",
    description: "Aria control plane: every open task across approvals, dropships, exceptions, runbook commands, and recent cron failures.",
};

export const dynamic = "force-dynamic";

export default function TasksPage() {
    return (
        <div className="min-h-screen bg-[#09090b] text-zinc-100">
            <div className="max-w-5xl mx-auto py-6 px-4 sm:px-6">
                <div className="flex items-center justify-between mb-6">
                    <div>
                        <Link
                            href="/dashboard"
                            className="inline-flex items-center gap-1 text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                            <ArrowLeft className="w-3 h-3" />
                            Dashboard
                        </Link>
                        <h1 className="text-2xl font-semibold text-zinc-100 mt-2">
                            Aria Tasks
                        </h1>
                        <p className="text-xs font-mono text-zinc-500 mt-1">
                            Unified queue across approvals · dropships · exceptions · runbook commands · cron failures (24h)
                        </p>
                    </div>
                </div>

                <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 overflow-hidden">
                    <TasksPanel />
                </div>

                <div className="mt-4 text-[10px] font-mono text-zinc-600">
                    Read-only in phase 1 of the control-plane plan. Approve / reject actions land in
                    phase 2 once the spoke writers are wired. See <span className="text-zinc-500">.agents/plans/control-plane.md</span>.
                </div>
            </div>
        </div>
    );
}
