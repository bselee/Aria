/**
 * @file    image-to-pdf.test.ts
 * @purpose Unit tests for phone-photo invoice → PDF conversion
 */
import { describe, it, expect } from "vitest";
import {
    imageBufferToPdf,
    imageFilenameToPdf,
    isInvoiceImagePart,
} from "./image-to-pdf";

describe("isInvoiceImagePart", () => {
    it("accepts large jpeg phone photos", () => {
        expect(isInvoiceImagePart("image/jpeg", "IMG_1137.jpeg", 4_000_000)).toBe(true);
    });
    it("rejects tiny logos", () => {
        expect(isInvoiceImagePart("image/png", "logo.png", 5_000)).toBe(false);
    });
    it("rejects unnamed parts", () => {
        expect(isInvoiceImagePart("image/jpeg", "", 2_000_000)).toBe(false);
    });
    it("accepts by extension when mime is generic", () => {
        expect(isInvoiceImagePart("application/octet-stream", "scan.JPG", 500_000)).toBe(true);
    });
});

describe("imageFilenameToPdf", () => {
    it("swaps extension", () => {
        expect(imageFilenameToPdf("IMG_1137.jpeg")).toBe("IMG_1137.pdf");
        expect(imageFilenameToPdf("photo.PNG")).toBe("photo.pdf");
    });
});

describe("imageBufferToPdf", () => {
    it("wraps a minimal valid JPEG into a PDF", async () => {
        // 1x1 red JPEG
        const jpeg = Buffer.from(
            "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGcP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//Z",
            "base64",
        );
        // If that base64 is invalid, generate via sharp
        let buf = jpeg;
        try {
            const sharp = (await import("sharp")).default;
            buf = await sharp({
                create: { width: 200, height: 300, channels: 3, background: { r: 240, g: 240, b: 240 } },
            })
                .jpeg()
                .toBuffer();
        } catch {
            /* use embedded jpeg */
        }

        const pdf = await imageBufferToPdf(buf, "image/jpeg");
        expect(pdf.subarray(0, 4).toString("utf8")).toBe("%PDF");
        expect(pdf.length).toBeGreaterThan(200);
    });
});
