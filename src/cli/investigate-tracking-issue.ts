console.log("Script starting...");
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "../lib/supabase";

async function run() {
    const supabase = createClient();
    if (!supabase) return;

    const query = "124607";
    console.log(`Searching for PO ${query} in logs...`);
    const { data: logs } = await supabase.from("ap_activity_log").select("*").or(`email_subject.ilike.%${query}%,metadata->>pdf_filename.ilike.%${query}%,metadata->>po_number.ilike.%${query}%`);
    
    if (logs) {
        logs.forEach(log => {
            console.log(`\nLog Date: ${log.created_at}`);
            console.log(`Action: ${log.action_taken}`);
            console.log(`Subject: ${log.email_subject}`);
        });
    }
}

run();
