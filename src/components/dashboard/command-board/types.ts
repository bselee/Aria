/**
 * @file    types.ts
 * @purpose Frontend re-export of command-board types. Keeps imports inside
 *          the command-board folder short and lets us swap in narrower local
 *          types if the backend module renames its exports.
 */

export type {
    CommandBoardAgent,
    CommandBoardCatalog,
    CommandBoardCatalogFile,
    CommandBoardControlRequest,
    CommandBoardCron,
    CommandBoardCronRun,
    CommandBoardHeartbeat,
    CommandBoardLane,
    CommandBoardReference,
    CommandBoardRun,
    CommandBoardRunFilters,
    CommandBoardSkill,
    CommandBoardSummary,
    CommandBoardTaskCard,
    CommandBoardTaskDetail,
    CommandBoardTaskEvent,
    CommandBoardTaskFilters,
    CommandBoardTaskList,
    CommandBoardWorkflow,
} from "@/lib/command-board/types";
