---
name: pdf-processing
description: Use when working with PDF text extraction, OCR, invoice parsing, or any vendor reconciler that processes PDF attachments
---

# PDF Processing

## The Working Pipeline

```
PDF buffer → extractPDF() → OpenRouter Gemini 2.5 Flash → full text → classify → Bill.com
```

**Use `extractPDF()` from `src/lib/pdf/extractor.ts`** — it's already wired up.

## Two Cases

```
PDF is text-based (digital)?
  → pdf-parse (fast, free, instant)

PDF is scanned/image?
  → OpenRouter google/gemini-2.5-flash
     PDF base64 → HTTP → ~60s for 22 pages → 40K chars extracted
```

## extractPDF Usage

```typescript
import { extractPDF } from '../lib/pdf/extractor';

const result = await extractPDF(pdfBuffer);
// result.rawText       — full extracted text
// result.pages[]       — per-page split (by form feed or evenly)
// result.metadata.pageCount
// result.ocrStrategy  — "pdf-parse" or "google/gemini-2.5-flash"
```

## For Page-Level Processing

```typescript
// extractPDF gives you full text. For per-page:
// 1. Split by \x0C (form feed) if pages use it
// 2. Or evenly divide by pageCount

const pages = result.rawText.split('\x0C');
// Then classify each page text with OpenRouter (fast, no vision needed)
```

## OpenRouter Call Pattern

```typescript
// Gemini 2.5 Flash accepts PDF base64 directly — no file upload needed
const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://aria.buildasoil.com",
        "X-Title": "BuildASoil AP",
    },
    body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{
            role: "user",
            content: [
                { type: "image_url", image_url: { url: `data:application/pdf;base64,${buffer.toString("base64")}` } },
                { type: "text", text: "Extract all text..." },
            ],
        }],
    }),
});
```

## Common Mistakes

1. **Don't use Playwright/canvas for PDFs** — it works but is slow, complex, and fragile. Use `extractPDF()`.
2. **Don't use Anthropic or OpenAI for PDF base64** — they don't support PDF base64 directly. Use OpenRouter Gemini.
3. **Text classification is faster than vision** — for page classification, send text snippets (first 300 chars) instead of page screenshots.
4. **OpenRouter `models` array doesn't always respect order** — call the specific model directly, not via `models` array with provider restrictions.

## Verified Working (2026-04-13)

- `google/gemini-2.5-flash` via OpenRouter — ✅ works with PDF base64, ~60s for 22 pages
- `anthropic/claude-haiku-4-5` via OpenRouter — ❌ 400 error on PDF base64
- `openai/gpt-4o-mini` via OpenRouter — unknown
- `extractPDF()` in `src/lib/pdf/extractor.ts` — use this, not manual approaches
- `src/cli/reconcile-aaa.ts` — working example
