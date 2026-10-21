/**
 * @file    page.tsx
 * @purpose ARIA Operations Dashboard — Command Board shell.
 * @author  Will
 * @created 2026-02-20
 * @updated 2026-10-21
 * @deps    command-board panel registry
 *
 * 2026-10-21 (Phase 4 cleanup): the legacy 4-column draggable panel wall and
 * the NEXT_PUBLIC_COMMAND_BOARD_ENABLED rollback flag were removed. The
 * command board has been the default surface since DECISION 2026-03-25 and
 * the legacy wall had not been the exercised path since. Rollback is now
 * `git revert` of this commit, not an env flag.
 */
"use client";

import CommandBoardShell from "@/components/dashboard/command-board/CommandBoardShell";

export default function DashboardPage() {
    return <CommandBoardShell />;
}
