import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { OpsManager } from "../lib/intelligence/ops-manager";

let ops: OpsManager;
try {
    ops = new OpsManager(null as any);
} catch (e: any) {
    console.error("Failed to initialize OpsManager:", e.message);
    process.exit(1);
}
console.log(`\nTriggering minimal purchasing calendar sync...\n`);
ops.syncPurchasingCalendarMinimal().then(r => {
    console.log(`\nDone: ${JSON.stringify(r)}`);
    process.exit(0);
}).catch(e => {
    console.error("Error:", e.message);
    process.exit(1);
});
