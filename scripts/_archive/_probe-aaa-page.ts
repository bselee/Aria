// What does the AAA Cooper PRO track page actually say for 64058937?
// The delivered branch in tracking-service.ts falls back to a bare /\bdelivered\b/i
// match with no date, which is exactly the shape that can be a legend string.
import { readFileSync } from "fs";

const env = readFileSync(".env.local", "utf8");
for (const l of env.split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const PRO = process.argv[2] || "64058937";
const url = `https://www.aaacooper.com/pwb/Transit/ProTrackResults.aspx?ProNum=${PRO}&AllAccounts=true`;

(async () => {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    const html = await r.text();
    console.log("http", r.status, "bytes", html.length);
    const text = html
        .replace(/<script[\s\S]*?<\/script/gi, " ")
        .replace(/<style[\s\S]*?<\/style/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ");
    console.log("--- occurrences of 'deliver' ---");
    const re = /deliver\w*/gi;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(text)) && n < 12) {
        console.log(`  … ${text.slice(Math.max(0, m.index - 90), m.index + 90)} …`);
        n++;
    }
    if (!n) console.log("  (none)");
    console.log("--- date-like strings ---");
    for (const d of text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+\d{1,2}:\d{2}\s*[AP]M)?/g)?.slice(0, 15) ?? []) console.log("  " + d);
    console.log("--- status words ---");
    for (const w of ["In Transit", "Out for Delivery", "Delivered", "Exception", "Picked", "Arrived", "Departed", "No records", "not found", "invalid"]) {
        if (text.toLowerCase().includes(w.toLowerCase())) console.log("  has:", w);
    }
    console.log("--- body excerpt ---");
    console.log(text.slice(0, 1200));
})();
