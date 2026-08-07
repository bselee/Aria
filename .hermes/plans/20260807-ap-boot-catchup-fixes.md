# Fix Doc — AP Boot Catch-up Review (2026-08-07)

Follow-up review of commit `1c20ef2` ("fix(ops): AP boot catch-up, po-cache
enqueue lock, stale_cron boot-grace"). Two real defects found in the shipped
boot wiring. Both fixed in the working tree — **uncommitted**.

---

## Defect 1 — catch-up blocked boot (severity: medium)

**What shipped in `1c20ef2`**

```ts
// start-bot.ts, inside the boot IIFE, BEFORE registerAllCommands()
const catchup = await runApBootCatchup();
```

**Why it's wrong**

`runApBootCatchup()` calls `runJobOnce("ap-polling")`, whose handler is:

1. `runLocalApForward()` — walks Gmail, downloads PDFs, forwards to Bill.com
2. `ops.pollAPInbox()`
3. `runPOSweep()`
4. `batchReconcileExistingFreight(20)`

Declared budget: `{ durationMs: 180_000 }` — **3 minutes**.

Because it was `await`ed inline before `registerAllCommands(bot, botDeps)` and
`installShutdownGuard(...)`, a real missed-window boot would have:

- delayed Telegram command registration up to 3 min (bot appears dead to Bill)
- delayed the graceful shutdown guard — a PM2 restart landing in that gap
  loses `chatHistory`
- risked PM2 flagging a slow start

This never surfaced live because the 8am window was already covered, so the
function short-circuited in ~30 ms. **The bug was latent on exactly the path
the feature exists to serve.**

**Fix applied**

Moved to a deferred, fire-and-forget kick placed *after* `registerAllCommands`
and `startBotControlPlane`, with a 5 s delay so boot settles first:

```ts
setTimeout(() => {
    void (async () => {
        try {
            const { runApBootCatchup } = await import('../lib/ops/ap-boot-catchup');
            console.log('[boot] Checking AP sparse-window catch-up...');
            const catchup = await runApBootCatchup();
            ...
        } catch (e: any) {
            console.warn(`[boot] AP catch-up failed (non-fatal): ${e.message}`);
        }
    })();
}, 5_000);
```

Boot is now never blocked by AP work.

---

## Defect 2 — self-covering window on the skip path (severity: low, real)

**What shipped in `1c20ef2`**

```ts
} else {
    console.log(`[boot] AP catch-up skipped (${catchup.reason}).`);
    await ops.cronHookSuccess("ap-polling").catch(() => undefined);
}
```

**Why it's wrong**

This was inherited reflexively from the old boot warmup, whose whole purpose was
to fake freshness so the 25-minute `stale_cron` threshold stopped screaming.
That reason is gone — the migration raised the AP threshold to 20 h, so the
marker is no longer needed.

Verified what `cronHookSuccess` actually does:

| Layer | Writes | Verdict |
|-------|--------|---------|
| `ops-manager.cronHookSuccess` | `oversightAgent.registerHeartbeat` + orchestrator notify | in-memory / heartbeat only |
| `safe-runner.cronHookSuccess` | `recordCronRun` (in-memory map) | in-memory only |
| `cron/history.recordStart` | `cron_runs` table | **not called here** |

So it does **not** write `cron_runs` — the catch-up decision source is safe and
cannot self-cover a genuinely missed window. Good news: no correctness bug.

But it is still wrong to keep: it stamps a **false success heartbeat for a job
that did not run**, which is exactly the class of self-deception that produced
the HerbsNOW false-`PO_RECEIVED` incident. Heartbeats should mean "this ran."

**Fix applied** — line removed. Skip path now only logs.

---

## Verified NOT a problem

**Double-run collision.** Worried the 5 s deferred kick could overlap the real
`0 8,12,17` cron tick. It cannot cause a double AP walk:

- `registry.ts:73` → `concurrency: def.concurrency ?? 1`
- `runner.ts:90` → `if (limiter.counts().EXECUTING >= job.concurrency) return { status: "skipped", failureReason: "concurrency-locked" }`

Second caller returns `skipped`. Forwarder dedup (`ap_local_forwards`) is a
second layer. Safe.

---

## Current state

| Item | State |
|------|-------|
| `1c20ef2` | pushed to `origin/main` |
| Migration (AP 25 m → 20 h) | applied to local Postgres, verified `20:00:00` in view |
| `src/cli/start-bot.ts` | **modified, uncommitted** — both fixes above |
| Tests | 41/41 pass (`po-cache-change`, `ap-boot-catchup`, `control-plane`, `cron/jobs`, `cron/runner`) |
| Running `aria-bot` | still on `1c20ef2` code — does NOT have these two fixes |

`npm run typecheck` was not completed — it OOMs / runs long on this repo. The
edit is a code-move plus one deleted line inside an already-typechecked block,
so risk is low, but it is **unverified by tsc**.

---

## Next steps (in order)

1. **Commit the fix**

   ```bash
   git add src/cli/start-bot.ts
   git commit -m "fix(ops): defer AP boot catch-up, drop false skip-path heartbeat"
   git push origin main
   ```

2. **Restart and confirm ordering**

   ```bash
   pm2 restart aria-bot
   sleep 20 && pm2 logs aria-bot --lines 60 --nostream | grep -E '\[boot\]'
   ```

   Expect `📅 Cron schedules registered` **before**
   `[boot] Checking AP sparse-window catch-up...` — that ordering is the proof
   Defect 1 is fixed.

3. **Prove the miss path (still unproven)**

   Only the *covered* branch has run live. To prove the real path, on a quiet
   evening after 17:00:

   ```bash
   # delete today's 17:00 cron_runs row on a throwaway basis, or simply restart
   # after 17:05 having stopped the bot before 17:00
   pm2 stop aria-bot     # before 17:00
   # ...wait past 17:00...
   pm2 start aria-bot
   pm2 logs aria-bot --lines 80 --nostream | grep -E 'AP catch-up|AP-Local'
   ```

   Want: `[boot] AP catch-up ran (... reason=window_missed ...)` followed by
   `[AP-Local]` output.

4. **DST edge (low priority)**

   `denverLocalToUtc` uses iterative offset resolution and is only tested in
   August (MDT). Add a November (MST) case to `ap-boot-catchup.test.ts` before
   the next time change.

---

## Still on hold

- **Keepalive revive proof** — requires stopping the live gateway; off-hours only
- **Billtrust** — `src/cli/reconcile-billtrust-freight.ts` untracked, live-unsafe
- **`stat-indexing`** — the one remaining real `stale_cron`, unrelated to this work
