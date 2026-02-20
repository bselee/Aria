# ARIA Setup Tasks

## ✅ Initial Setup
- [x] Create core document taxonomy (`src/types/documents.ts`)
- [x] Integrate PDF extraction logic (`src/lib/pdf/extractor.ts`)
- [x] Set up LLM classification logic (`src/lib/pdf/classifier.ts`)
- [x] Prepare invoice and PO parsers (`src/lib/pdf/invoice-parser.ts`, `src/lib/pdf/po-parser.ts`)
- [x] Set up matching logic (`src/lib/matching/invoice-po-matcher.ts`)
- [x] Integrate Gmail attachments layer (`src/lib/gmail/attachment-handler.ts`)
- [x] Add Firecrawl vendor enrichment (`src/lib/vendors/enricher.ts`)
- [x] Define BOL parsing (`src/lib/pdf/bol-parser.ts`)
- [x] Connect GitHub clients API (`src/lib/github/client.ts`, `src/app/api/webhooks/github/route.ts`)
- [x] Integrate Supabase PDF bucket storage wrapper (`src/lib/storage/supabase-storage.ts`)
- [x] Write SQL schema file for documents (`migrations/001_documents.sql`)
- [x] Create Viewer UI Template (`src/components/documents/DocumentViewer.tsx`)
- [x] Create Next.js `package.json` with dependencies included.

## 🚀 Environment Setup & Packages
- [x] Run `npm install` inside the aria directory to initialize dependencies.
- [x] Add `elevenlabs` (for Voice), `telegraf` (for Telegram bots), and `dotenv` to `package.json` and install them.
- [x] Set up the `.env.local` with API keys securely read dynamically from environment configuration or MCP settings.

## 🎙️ Additional Third-Party Providers Setup
- [x] Add Telegram configuration file (`src/lib/telegram/bot.ts`).
- [x] Add ElevenLabs interface configuration (`src/lib/voice/elevenlabs.ts`).
- [x] Integrate Aria "Ruthlessly Helpful" Persona & Anthropic Brain.
- [x] Connect Voice (ElevenLabs) to Telegram `/voice` command.

## 🗄️ Routing Layer Configuration (To-Do)
- [ ] Configure top-level layout wrapper (`src/app/layout.tsx`).
- [ ] Route structure for documents (`src/app/(dashboard)/documents/page.tsx`).
- [ ] Ensure the file upload endpoints function securely.

## 🛡️ Validation & Pre-Deployment Reviews
- [ ] Verify Supabase bucket `aria-documents` is established and correctly permissive/restrictive based on roles.
- [ ] Sync up with Firebase/Gmail token states so the `attachment-handler.ts` isn't dropping incoming files on authentication bounces.
- [ ] Test invoice discrepancy triggers manually edge cases.
