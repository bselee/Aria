import { defineJob } from "../registry";
import { OpsManager } from "../../lib/intelligence/ops-manager";
import { sumPOs } from "../../lib/purchasing/notification-utils";

const ops = () => OpsManager.singleton;

export const name = "po-state-guardian";

defineJob({
  name: "po-state-guardian",
  schedule: "*/30 * * * *",
  onFail: "telegram-will",
  description: "Detect accidental PO cancellations and enforce receive-before-forward",
  handler: async () => {
    const o = ops();
    if (!o) return;

    // Filter: POs canceled in last 1h with no receiving, not finalized
    const problematic = await o.findProblematicPOs({
      hoursSinceCancel: 1,
      skipReceivings: true,
      finalized: false
    });

    if (!problematic.length) {
      console.log("[po-state-guard] No accidental cancellations detected");
      return;
    }


    // 1) Stop-gap: disable cancellation tracking for <30d old POs
    problematic.forEach(async (po) => {
      if (po.ageInDays < 30) {
        await po.setCancellationLock("Guard: recent accidental cancellation");
      }
    });

    // 2) Surface to Bill with actionable agent task
    const { notifyViaTask } = await import("../../lib/intelligence/notify-via-task");
    await notifyViaTask({
      sourceId: "po-guardian",
      type: "po_correction",
      goal: `Recent PO cancellation(s): ${problematic.map(p => p.docNum).join(", ")}\n(uncANCELED after 1h to avoid working bad invoice state)\nApprove correction or let run out`
      inputs: { pofix: problematic },
      priority: 0
    });

    console.log(`[po-state-guard] ${problematic.length} accidental cancellation(s) protected`);
  },
});

// Add to index.ts with:
// import { name, defineJob } from "./po-state-guardian";