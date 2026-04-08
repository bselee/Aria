const fs = require('fs');

let content = fs.readFileSync('src/lib/purchasing/uline-session.ts', 'utf8');

const regex = /export async function launchUlineSession\(opts: LaunchUlineSessionOptions\): Promise<UlineSession> \{[\s\S]*?\}\s*\}\n/m;

const replacement = `export async function launchUlineSession(opts: LaunchUlineSessionOptions): Promise<UlineSession> {
    try {
        const context = await chromium.launchPersistentContext(
            CHROME_PROFILE,
            {
                headless: opts.headless,
                channel: "chrome",
                acceptDownloads: true,
                viewport: { width: 1280, height: 900 },
                args: ["--profile-directory=Default", "--disable-blink-features=AutomationControlled"],
            },
        );
        return {
            context,
            close: async () => {
                await context.close();
            },
        };
    } catch {
        // Fallback to sterile session if Chrome is locked/running
        const storageStatePath = path.join(os.homedir(), ".uline-cookies.json");

        const browser = await chromium.launch({
            headless: opts.headless,
            channel: "chrome",
            args: ["--disable-blink-features=AutomationControlled"],
        });
        
        const fsLib = require("fs");
        const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            storageState: fsLib.existsSync(storageStatePath) ? storageStatePath : undefined,
        });

        return {
            context,
            close: async () => {
                try { await context.storageState({ path: storageStatePath }); } catch {}
                await context.close();
                await browser.close();
            },
        };
    }
}
`;

content = content.replace(regex, replacement);
fs.writeFileSync('src/lib/purchasing/uline-session.ts', content, 'utf8');
console.log('Fixed uline-session.ts');
