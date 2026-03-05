import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function checkQueue() {
    const { data: apQueue } = await supabase.from("ap_inbox_queue").select("*").order("created_at", { ascending: false }).limit(5);
    console.log("AP Inbox Queue:", JSON.stringify(apQueue, null, 2));

    const { data: emailQueue } = await supabase.from("email_inbox_queue").select("*").order("created_at", { ascending: false }).limit(5);
    console.log("Email Inbox Queue:", JSON.stringify(emailQueue, null, 2));
}

checkQueue();
