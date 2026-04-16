import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { OpsManager } from "../lib/intelligence/ops-manager";

const days = parseInt(process.argv[2] || "30", 10);
let ops: OpsManager;
try {
    ops = new OpsManager(null as any);
} catch (e: any) {
    console.error("Failed to initialize OpsManager:", e.message);
    process.exit(1);
}
console.log(`\nTriggering calendar sync for last ${days} days...\n`);
ops.syncPurchasingCalendar(days).then(r => {
    console.log(`\nDone: ${JSON.stringify(r)}`);
    process.exit(0);
}).catch(e => {
    console.error("Error:", e.message);
    process.exit(1);
});
