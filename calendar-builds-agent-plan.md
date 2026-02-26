# Calendar Builds Agent Plan

**Objective**: Create a "Calendar Builds Agent" that connects to Google Calendars (Soil & Manufacturing), parses the daily production schedule over a 30-day horizon, explodes the schedules into Bill of Materials (BOM) requirements via Finale Inventory, and checks against current stock levels to predict components that need to be reordered.

**Calendars**:
1. Soil Calendar - `gabriel.wilson@buildasoil.com`
2. Manufacturing (MFG) Calendar - `manufacturing@buildasoil.com`

---

## Architecture / Data Flow

### 1. Ingestion: Google Calendar Data
- Provide Google Service Account integration logic via `@googleapis/calendar`.
- Authenticate to Google APIs using Service Account Keys.
- Target the specified calendar IDs for querying.
- Query timeframe: Current day to T+30 Days.
- Output: A unified list of all scheduled events (production runs), including titles, dates, descriptions, and durations.

### 2. Processing: LLM SKU Extraction
- Production event names are typically unstructured human text (e.g., "Build 500x Clackamas Coot").
- Use an LLM (e.g. OpenAI GPT-4o-mini or Anthropic Claude 3.5 Sonnet) via `ai` / `@ai-sdk/openai` to parse the event strings.
- Provide a system prompt equipped with a reference list of valid Finished Good SKUs.
- Enforce strict structured JSON output defining `{ "sku": string, "quantity": number, "buildDate": string }`.

### 3. Transformation: BOM Explosion (Finale API)
- Given a list of Scheduled Builds (Finished Good SKUs + Qty), integrate with Finale Inventory's Bill of Materials API.
- Explode each Manufactured SKU to identify its required raw ingredients / components and their required ratios.
- Multiply the ratio by the planned quantity to get total raw component demand for each scheduled build.
- Aggregate all raw component requirements over the 30-day horizon to get **Total 30-Day Component Demand**.

### 4. Analysis: Stock vs. Demand Profiling
- Use `FinaleClient` (`src/lib/finale/client.ts`) to query current On-Hand Stock and Incoming POs (On-Order) for each required component.
- Calculate Estimated Deficit Date and Risk:
  - `Available Runaway = (Current Stock + Confirmed POs) - Pending 30-Day Calendar Demand`
- Identify any component whose requirements exceed available stock. Flag these as **At-Risk Components**.

### 5. Notification & Reporting
- Generate a comprehensive "30-Day Production Stockout Risk Report".
- Format clearly identifying:
  1. Component SKU & Name
  2. Total Required by Calendar in next 30 Days
  3. Current Stock + Incoming POs
  4. Shortfall Amount (Quantity to Order)
  5. Critical Dates (When does stock hit zero?)
- Output the report to the existing Telegram / Slack bot interfaces (e.g. via a daily `/buildrisk` command or a cron job).

---

## Execution Phases

### Phase 1: Google Calendar & LLM Extractor
- Set up a new Google Service Account (`google-credentials.json`).
- Ensure `gabriel.wilson@buildasoil.com` and `manufacturing@buildasoil.com` are shared with the service account email.
- Create `src/lib/google/calendar.ts` for fetching events.
- Create `src/lib/intelligence/build-parser.ts` to parse unstructured Calendar text to structured SKU objects.

### Phase 2: Finale BOM Integration
- Extend `src/lib/finale/client.ts` or add `bom-explorer.ts` to retrieve BOM component allocations for any given Finished Good SKU.
- Write the function that explodes the 30-Day Build Plan into an aggregated Raw Materials Demand table.

### Phase 3: Math, Reporting, and Bot Integration
- Build a new agent script `src/cli/calendar-builds-agent.ts`.
- Combine the data: Scheduled Builds -> BOM Explosion -> Stock Verification.
- Add formatting for Telegram alerts (similar to `getBOMConsumption` output).
- Setup execution path (either via Telegram slash command or standalone scheduled process).
