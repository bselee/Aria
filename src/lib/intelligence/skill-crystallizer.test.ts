import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
    createClientMock: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
    createClient: createClientMock,
}));

import { SkillCrystallizer } from "./skill-crystallizer";

describe("SkillCrystallizer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("persists skills using the real schema", async () => {
        const insertMock = vi.fn(() => ({
            select: vi.fn(() => ({
                single: vi.fn().mockResolvedValue({ data: { id: "skill-1" }, error: null }),
            })),
        }));
        createClientMock.mockReturnValue({
            from: vi.fn((table: string) => {
                if (table === "skills") {
                    return {
                        insert: insertMock,
                    };
                }
                throw new Error(`unexpected table ${table}`);
            }),
        });

        const crystallizer = new SkillCrystallizer();
        await crystallizer.crystallize({
            name: "reconcile_uline_invoice",
            description: "Reconcile a standard ULINE invoice",
            trigger: "invoice from ULINE with a PDF attachment",
            agentName: "ap-agent",
            steps: [{
                order: 1,
                action: "tool_call",
                name: "extract_pdf",
                params: {},
            }],
        } as any);

        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            name: "reconcile_uline_invoice",
            description: "Reconcile a standard ULINE invoice",
            trigger: "invoice from ULINE with a PDF attachment",
            agent_name: "ap-agent",
            steps: [{
                order: 1,
                action: "tool_call",
                name: "extract_pdf",
                params: {},
            }],
            review_status: "pending",
            archived: false,
        }));
    });

    it("records shadow runs in task history", async () => {
        const taskHistoryInsertMock = vi.fn().mockResolvedValue({ error: null });
        createClientMock.mockReturnValue({
            from: vi.fn((table: string) => {
                if (table === "task_history") {
                    return {
                        insert: taskHistoryInsertMock,
                    };
                }
                if (table === "skills") {
                    return {
                        update: vi.fn(() => ({
                            eq: vi.fn().mockResolvedValue({ error: null }),
                        })),
                    };
                }
                throw new Error(`unexpected table ${table}`);
            }),
        });

        const crystallizer = new SkillCrystallizer();
        await (crystallizer as any).recordShadowRun({
            skillId: "skill-1",
            agentName: "ap-agent",
            taskType: "invoice reconciliation",
            inputSummary: "ULINE invoice",
            outputSummary: "shadow match suggested",
        });

        expect(taskHistoryInsertMock).toHaveBeenCalledWith(expect.objectContaining({
            skill_id: "skill-1",
            agent_name: "ap-agent",
            status: "shadow",
        }));
    });
});
