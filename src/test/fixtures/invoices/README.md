# Gold-Sample Invoice Fixtures

This directory contains OCR text samples from real vendor invoices.
Each `.txt` file is the raw text output from PDF extraction.
Each `.expected.json` file defines the expected parsed fields.

## Adding a new vendor sample

1. Extract a real invoice: `node --import tsx src/cli/run-ap-pipeline.ts`
2. Copy the raw OCR text to a new `.txt` file here
3. Create a matching `.expected.json` with the correct field values
4. Run `npx vitest run src/test/gold-sample-invoices.test.ts` to verify

## Purpose

These fixtures test the deterministic extraction layer (regex PO, vendor
parsers, shipping extraction) WITHOUT calling any LLM. The LLM mock
returns a generic/weak parse, and the test verifies that the deterministic
layer corrects the critical fields.
