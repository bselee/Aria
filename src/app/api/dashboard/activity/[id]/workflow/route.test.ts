import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMock = vi.fn();
const eqMock = vi.fn();
const selectMock = vi.fn();
const singleMock = vi.fn();

const supabase = {
    from: vi.fn(() => ({
        update: updateMock,
    })),
};

vi.mock("@/lib/supabase", () => ({
    createClient: () => supabase,
}));

import { PATCH } from "./route";

describe("activity workflow route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        singleMock.mockResolvedValue({
            data: {
                id: "act-1",
                human_note: "Check vendor promise.",
                process_state: "opened",
                resolution: "waiting_on_vendor",
                learning_candidate: true,
            },
            error: null,
        });
        selectMock.mockReturnValue({ single: singleMock });
        eqMock.mockReturnValue({ select: selectMock });
        updateMock.mockReturnValue({ eq: eqMock });
    });

    it("patches allowed workflow fields on an AP activity row", async () => {
        const response = await PATCH(
            new Request("http://localhost/api/dashboard/activity/act-1/workflow", {
                method: "PATCH",
                body: JSON.stringify({
                    note: "Check vendor promise.",
                    processState: "opened",
                    resolution: "waiting_on_vendor",
                    learningCandidate: true,
                    ignored: "nope",
                }),
            }),
            { params: Promise.resolve({ id: "act-1" }) } as any,
        );

        expect(response.status).toBe(200);
        expect(supabase.from).toHaveBeenCalledWith("ap_activity_log");
        expect(updateMock).toHaveBeenCalledWith({
            human_note: "Check vendor promise.",
            human_note_by: "will",
            human_note_at: expect.any(String),
            process_state: "opened",
            resolution: "waiting_on_vendor",
            learning_candidate: true,
        });
        expect(eqMock).toHaveBeenCalledWith("id", "act-1");
        expect(await response.json()).toEqual({
            activity: {
                id: "act-1",
                human_note: "Check vendor promise.",
                process_state: "opened",
                resolution: "waiting_on_vendor",
                learning_candidate: true,
            },
        });
    });

    it("rejects unsupported process states", async () => {
        const response = await PATCH(
            new Request("http://localhost/api/dashboard/activity/act-1/workflow", {
                method: "PATCH",
                body: JSON.stringify({ processState: "maybe_later" }),
            }),
            { params: Promise.resolve({ id: "act-1" }) } as any,
        );

        expect(response.status).toBe(400);
        expect(updateMock).not.toHaveBeenCalled();
    });
});
