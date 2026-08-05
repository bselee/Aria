/**
 * @file    client.test.ts
 * @purpose Unit tests for the LTL Select client: auth request shape, pagination,
 *          pageSize clamp (API rejects >20), and error surfaces. fetch is mocked.
 * @author  Hermia
 * @created 2026-08-05
 * @deps    vitest, client.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    fetchLtlSelectInvoices,
    getLtlSelectToken,
    loadLtlSelectEnv,
    type LtlSelectEnv,
} from "./client";

const TEST_ENV: LtlSelectEnv = {
    username: "freight@buildasoil.com",
    password: "s3cret",
    auth0Domain: "auth0.ltlselect.com",
    clientId: "6GABAp6GEkh4w3dXlJdD0lwkgF62Dqmd",
    audience: "https://api.ltlselect.com/",
    apiBase: "https://k8s-prod.ltlselect.com/api/1",
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("loadLtlSelectEnv", () => {
    const original = { ...process.env };

    afterEach(() => {
        process.env = original;
    });

    it("throws and lists missing variables without echoing values", () => {
        delete process.env.LTLSELECT_USER;
        delete process.env.LTLSELECT_PASS;
        expect(() => loadLtlSelectEnv(process.env)).toThrow(/LTLSELECT_USER/);
    });

    it("reads all six variables", () => {
        process.env.LTLSELECT_USER = "u";
        process.env.LTLSELECT_PASS = "p";
        process.env.LTLSELECT_AUTH0_DOMAIN = "d";
        process.env.LTLSELECT_CLIENT_ID = "c";
        process.env.LTLSELECT_AUDIENCE = "a";
        process.env.LTLSELECT_API_BASE = "https://x/api/1/";
        const env = loadLtlSelectEnv(process.env);
        expect(env.apiBase).toBe("https://x/api/1"); // trailing slash stripped
        expect(env.username).toBe("u");
    });
});

describe("getLtlSelectToken", () => {
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("posts the password grant and returns the access token", async () => {
        const fetchMock = vi.mocked(global.fetch).mockResolvedValueOnce(
            jsonResponse({ access_token: "tok123", expires_in: 86400 }),
        );

        const token = await getLtlSelectToken(TEST_ENV);

        expect(token).toBe("tok123");
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe("https://auth0.ltlselect.com/oauth/token");
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({
            grant_type: "password",
            username: "freight@buildasoil.com",
            client_id: "6GABAp6GEkh4w3dXlJdD0lwkgF62Dqmd",
            audience: "https://api.ltlselect.com/",
        });
    });

    it("throws on non-OK auth response", async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ error: "bad" }, 401));
        await expect(getLtlSelectToken(TEST_ENV)).rejects.toThrow(/auth failed \(401\)/);
    });
});

describe("fetchLtlSelectInvoices", () => {
    beforeEach(() => {
        global.fetch = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("requests pageSize ≤ 20 and follows pagination until totalCount", async () => {
        const fetchMock = vi.mocked(global.fetch);
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ list: [item("a"), item("b")], totalCount: 3 }))
            .mockResolvedValueOnce(jsonResponse({ list: [item("c")], totalCount: 3 }));

        const result = await fetchLtlSelectInvoices("tok", TEST_ENV, {
            dateFrom: "2026-05-07",
            dateTo: "2026-08-05",
            pageSize: 25, // must be clamped to 20
        });

        expect(result.invoices.map((i) => i._id)).toEqual(["a", "b", "c"]);
        expect(result.totalCount).toBe(3);
        expect(fetchMock.mock.calls.length).toBe(2);

        const [url0, init0] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url0).toContain("pageSize=20");
        expect(url0).toContain("pageNumber=1");
        expect(url0).toContain("dateFrom=2026-05-07");
        expect(url0).toContain("dateTo=2026-08-05");
        expect(url0).toContain("userTimezoneOffset=360");
        expect((init0?.headers as Record<string, string>).Authorization).toBe("Bearer tok");

        const [url1] = fetchMock.mock.calls[1] as [string];
        expect(url1).toContain("pageNumber=2");
    });

    it("stops early on an empty page", async () => {
        const fetchMock = vi.mocked(global.fetch);
        fetchMock.mockResolvedValueOnce(jsonResponse({ list: [item("x")], totalCount: 99 }));
        fetchMock.mockResolvedValueOnce(jsonResponse({ list: [], totalCount: 99 }));

        const result = await fetchLtlSelectInvoices("tok", TEST_ENV, {
            dateFrom: "2026-01-01",
            dateTo: "2026-02-01",
        });
        expect(result.invoices.length).toBe(1);
        expect(fetchMock.mock.calls.length).toBe(2);
    });

    it("throws on non-OK page response", async () => {
        vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ error: "Page size or page number out of range" }, 400));
        await expect(
            fetchLtlSelectInvoices("tok", TEST_ENV, { dateFrom: "2026-01-01", dateTo: "2026-02-01" }),
        ).rejects.toThrow(/invoice fetch failed \(400\)/);
    });

    it("accepts a custom timezone offset", async () => {
        const fetchMock = vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ list: [], totalCount: 0 }));
        await fetchLtlSelectInvoices("tok", TEST_ENV, {
            dateFrom: "2026-01-01",
            dateTo: "2026-02-01",
            userTimezoneOffset: 300,
        });
        expect((fetchMock.mock.calls[0] as [string])[0]).toContain("userTimezoneOffset=300");
    });
});

function item(id: string): { _id: string } {
    return { _id: id };
}
