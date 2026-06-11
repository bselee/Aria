# Aria

Will's personal operations assistant for BuildASoil. See `CLAUDE.md` for full architecture and commands.

## Authentication

Two secrets must be set in `.env.local` before running the dashboard or accepting GitHub webhooks. See `.env.example` for the full list.

### Dashboard API (`DASHBOARD_API_TOKEN`)

All `/api/dashboard/*` routes are protected by a bearer-token middleware (`src/middleware.ts`). Every request must include:

```
Authorization: Bearer <DASHBOARD_API_TOKEN>
```

Requests without a matching token return `401 Unauthorized`. If the env var is unset, the middleware fails closed with `503 Auth not configured`. Generate a strong value with:

```bash
openssl rand -hex 32
```

### GitHub Webhook (`GITHUB_WEBHOOK_SECRET`)

The `/api/webhooks/github` route validates the `X-Hub-Signature-256` HMAC header against `GITHUB_WEBHOOK_SECRET`. The value must exactly match the secret configured on the GitHub repo webhook (`Settings → Webhooks → Secret`). Requests with a missing, malformed, or invalid signature are rejected (`401`/`403`).
