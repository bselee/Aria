import { beforeEach, describe, expect, it, vi } from "vitest";

const upload = vi.fn();
const insert = vi.fn();
const insertSelect = vi.fn();
const maybeSingle = vi.fn();

const supabase = {
    from: vi.fn((table: string) => {
        if (table !== "statement_intake_queue") {
            throw new Error(`Unexpected table ${table}`);
        }
        return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle,
            insert: insert.mockImplementation(() => ({
                select: insertSelect,
            })),
        };
    }),
    storage: {
        from: vi.fn(() => ({
            upload,
        })),
    },
};

vi.mock("@/lib/supabase", () => ({
    createClient: () => supabase,
}));

import { queueStatementEmailIntake } from "./email-intake";

describe("queueStatementEmailIntake", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        maybeSingle.mockResolvedValue({ data: null, error: null });
        upload.mockResolvedValue({ error: null });
        insertSelect.mockResolvedValue({ data: [{ id: "intake_1" }], error: null });
    });

    it("stores the attachment and inserts a ready email_statement intake row", async () => {
        const result = await queueStatementEmailIntake({
            gmailMessageId: "msg_1",
            sourceInbox: "ap",
            vendorName: "FedEx",
            emailFrom: "billing@fedex.com",
            emailSubject: "March statement",
            filename: "statement.pdf",
            contentType: "application/pdf",
            buffer: Buffer.from("fake pdf"),
        });

        expect(upload).toHaveBeenCalledOnce();
        expect(insert).toHaveBeenCalledOnce();
        expect(insert.mock.calls[0][0]).toMatchObject({
            vendor_name: "FedEx",
            source_type: "email_statement",
            source_ref: "msg_1",
            artifact_kind: "pdf",
            adapter_key: "email_statement",
            status: "ready",
            queued_by: "ap_identifier",
        });
        expect(result).toBe("intake_1");
    });

    it("returns the existing intake id when the fingerprint already exists", async () => {
        maybeSingle.mockResolvedValue({ data: { id: "intake_existing" }, error: null });

        const result = await queueStatementEmailIntake({
            gmailMessageId: "msg_1",
            sourceInbox: "ap",
            vendorName: "FedEx",
            emailFrom: "billing@fedex.com",
            emailSubject: "March statement",
            filename: "statement.pdf",
            contentType: "application/pdf",
            buffer: Buffer.from("fake pdf"),
        });

        expect(upload).not.toHaveBeenCalled();
        expect(insert).not.toHaveBeenCalled();
        expect(result).toBe("intake_existing");
    });
});
