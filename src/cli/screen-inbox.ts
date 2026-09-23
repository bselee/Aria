/**
 * @file    screen-inbox.ts
 * @purpose One-shot bill.selee@ screen. Drains unread mail now, including
 *          everything that landed before 8am. No Finale writes.
 * @author  Hermia
 * @created 2026-09-23
 *
 *   node --env-file=.env.local --import tsx src/cli/screen-inbox.ts
 */
import { screenDefaultInbox } from "@/lib/intelligence/inbox-screen";

screenDefaultInbox()
    .then((r) => {
        console.log(JSON.stringify(r));
        process.exit(0);
    })
    .catch((err) => {
        console.error(err?.message || err);
        process.exit(1);
    });
