import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the underlying memory backends so the facade tests stay focused on
// dispatch + audit wiring (not the Pinecone implementation).
const rememberMock = vi.hoisted(() => vi.fn().mockResolvedValue("memory-id-1"));
const recallMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const storeVendorMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const getVendorMock = vi.hoisted(() => vi.fn().mockResolvedValue({ vendor: "X", documentTypes: [], notes: "" }));

vi.mock("@/lib/intelligence/memory", () => ({
    remember: rememberMock,
    recall: recallMock,
}));
vi.mock("@/lib/intelligence/vendor-memory", () => ({
    storeVendorPattern: storeVendorMock,
    getVendorPattern: getVendorMock,
}));

// Mock supabase so the audit wrapper doesn't try to write
vi.mock("@/lib/db", () => ({ createClient: () => null }));

import { put, get, query, memory } from "./index";

beforeEach(() => {
    rememberMock.mockClear();
    recallMock.mockClear();
    storeVendorMock.mockClear();
    getVendorMock.mockClear();
});

describe("Memory facade — put", () => {
    it("aria-memory put dispatches to pineconeRemember", async () => {
        const id = await put("aria-memory", {
            category: "decision",
            content: "test memory",
            tags: ["test"],
        } as any);
        expect(id).toBe("memory-id-1");
        expect(rememberMock).toHaveBeenCalledTimes(1);
        expect(rememberMock.mock.calls[0][0].content).toBe("test memory");
    });

    it("vendor-memory put dispatches to storeVendorPattern", async () => {
        await put("vendor-memory", { vendor: "ULINE" } as any);
        expect(storeVendorMock).toHaveBeenCalledTimes(1);
        expect(storeVendorMock.mock.calls[0][0].vendor).toBe("ULINE");
    });
});

describe("Memory facade — get", () => {
    it("vendor-memory get dispatches to getVendorPattern", async () => {
        const result = await get("vendor-memory", "ULINE");
        expect(result?.vendor).toBe("X");
        expect(getVendorMock).toHaveBeenCalledWith("ULINE");
    });
});

describe("Memory facade — query", () => {
    it("aria-memory query dispatches to pineconeRecall with options passed through", async () => {
        await query("aria-memory", "what did we approve last week", { topK: 3, category: "decision" });
        expect(recallMock).toHaveBeenCalledTimes(1);
        expect(recallMock.mock.calls[0][0]).toBe("what did we approve last week");
        expect(recallMock.mock.calls[0][1]).toEqual({ topK: 3, category: "decision" });
    });
});

describe("Memory facade — `memory` namespace bundle", () => {
    it("memory.put / memory.get / memory.query are the same functions", async () => {
        expect(memory.put).toBe(put);
        expect(memory.get).toBe(get);
        expect(memory.query).toBe(query);
    });
});
