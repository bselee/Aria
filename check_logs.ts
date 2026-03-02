import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkData() {
    const { data, error } = await supabase.from('ap_activity_log').select('*').limit(5);
    if (error) {
        console.error("Error fetching:", error.message);
    } else {
        console.log(`Found ${data.length} records in ap_activity_log.`);
        console.log(data);
    }
}

checkData();
