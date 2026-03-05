import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import EasyPostClient from "@easypost/api";

const client = new EasyPostClient(process.env.EASYPOST_API_KEY!);

async function run() {
    try {
        const tracker = await client.Tracker.create({
            tracking_code: "1Z234589230598",
        });
        console.log("Tracker created:", tracker.id, tracker.status, tracker.est_delivery_date);
    } catch (e: any) {
        console.error("Error creating tracker:", e.message);
    }
}
run();
