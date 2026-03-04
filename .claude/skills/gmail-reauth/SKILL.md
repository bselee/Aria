---
name: gmail-reauth
description: |
  Re-authenticate Gmail OAuth tokens for Aria's two Gmail accounts.
  Use when Gmail API calls start returning 401/403, token expired errors,
  or when setting up on a new machine. Also covers Google Calendar token refresh.
allowed-tools:
  - Bash(node --import tsx src/cli/gmail-auth.ts *)
  - Bash(node --import tsx src/cli/calendar-auth.ts)
---

# Gmail Re-authentication (Aria)

Aria uses OAuth2 for two Gmail accounts and one Google Calendar. Tokens are stored as JSON files in the project root.

## Token Files
| File | Account | Slot | Used By |
|------|---------|------|---------|
| `ap-token.json` | ap@buildasoil.com | `"ap"` | AP agent — incoming invoices |
| `token.json` | bill.selee@buildasoil.com | `"default"` | PO correlator — outgoing POs |
| `calendar-token.json` | (Calendar) | — | Build parser, calendar lookups |

## Re-authenticate Gmail (AP account)
```bash
node --import tsx src/cli/gmail-auth.ts ap
```
Opens browser for OAuth flow → saves to `ap-token.json`

## Re-authenticate Gmail (Default / bill.selee account)
```bash
node --import tsx src/cli/gmail-auth.ts
# or explicitly:
node --import tsx src/cli/gmail-auth.ts default
```
Opens browser for OAuth flow → saves to `token.json`

## Re-authenticate Google Calendar
```bash
node --import tsx src/cli/calendar-auth.ts
```
Opens browser for OAuth flow → saves to `calendar-token.json`

## When Tokens Expire
Gmail tokens typically last until revoked. They may expire if:
- Google security settings revoke access
- OAuth consent screen not used for 6+ months
- App credentials changed

## Required Env Vars
```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
```
These are in `.env.local` and come from `google-credentials.json`.

## After Re-auth
The bot picks up the new token on next use — no restart required for token refresh.
However, if the bot is currently failing with auth errors, restart after re-auth:
```bash
pm2 restart aria-bot
```
