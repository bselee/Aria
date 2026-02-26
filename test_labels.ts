import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { google } from "googleapis";
import { getAuthenticatedClient } from "./src/lib/gmail/auth";

async function run() {
    const auth = await getAuthenticatedClient("ap");
    const gmail = google.gmail({ version: "v1", auth });

    const res = await gmail.users.labels.list({ userId: "me" });
    console.log(res.data.labels);
}

run().catch(console.error);
