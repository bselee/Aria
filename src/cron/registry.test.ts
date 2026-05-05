import { describe, it, expect, beforeEach } from "vitest";
import { defineJob, getJob, listJobs, _resetRegistry } from "./registry";

describe("cron registry", () => {
    beforeEach(() => _resetRegistry());

    it("registers a job and retrieves it by name", () => {
        defineJob({
            name: "test-job",
            schedule: "*/5 * * * *",
            tz: "America/Denver",
            handler: async () => { /* noop */ },
        });
        const job = getJob("test-job");
        expect(job).toBeDefined();
        expect(job!.schedule).toBe("*/5 * * * *");
    });

    it("rejects duplicate names", () => {
        defineJob({ name: "dup", schedule: "* * * * *", handler: async () => {} });
        expect(() => defineJob({ name: "dup", schedule: "* * * * *", handler: async () => {} }))
            .toThrow(/already registered/i);
    });

    it("requires a name and a schedule", () => {
        expect(() => defineJob({ name: "", schedule: "* * * * *", handler: async () => {} } as any))
            .toThrow();
        expect(() => defineJob({ name: "x", schedule: "", handler: async () => {} } as any))
            .toThrow();
    });

    it("listJobs returns all registered jobs in stable alphabetical order", () => {
        defineJob({ name: "b", schedule: "* * * * *", handler: async () => {} });
        defineJob({ name: "a", schedule: "* * * * *", handler: async () => {} });
        const names = listJobs().map(j => j.name);
        expect(names).toEqual(["a", "b"]);
    });

    it("defaults concurrency to 1, enabled to true, tz to America/Denver", () => {
        defineJob({ name: "defaults", schedule: "* * * * *", handler: async () => {} });
        const job = getJob("defaults")!;
        expect(job.concurrency).toBe(1);
        expect(job.enabled).toBe(true);
        expect(job.tz).toBe("America/Denver");
    });
});
