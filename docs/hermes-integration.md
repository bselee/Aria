# Hermes Agent Integration — Aria

Hermes Agent is the cognition layer for Aria. It provides the ACP (Agent Communication Protocol) interface and the OpenAI-compatible API server.

## API Server (OpenAI-compatible)

```
Endpoint: http://127.0.0.1:8642/v1/chat/completions
Models:   hermes-agent
Auth:     Bearer token (API_SERVER_KEY in ~/.hermes/.env)
```

### Quick Test
```bash
source ~/.hermes/.env
curl -H "Authorization: Bearer *** http://127.0.0.1:8642/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"What is the status of PO-12345?"}]}'
```

### Open WebUI / LibreChat / Cursor Config
```
API Base URL: http://127.0.0.1:8642/v1
API Key:      (same as API_SERVER_KEY in ~/.hermes/.env)
Model:        hermes-agent
```

### Available Endpoints
| Endpoint | Purpose |
|----------|---------|
| `POST /v1/chat/completions` | Chat (OpenAI format, session continuity via X-Hermes-Session-Id) |
| `POST /v1/responses` | Responses API (stateful via previous_response_id) |
| `GET /v1/models` | List models |
| `GET /health` | Health check |
| `GET /api/sessions` | List sessions |
| `POST /api/sessions/{id}/chat` | Chat with a specific session |
| `GET /v1/capabilities` | Machine-readable capabilities |

## ACP (Agent Communication Protocol)

For IDE integration (VS Code, Zed, JetBrains). Run:
```bash
hermes acp
```

The ACP server communicates via stdio. Configure your IDE to launch:
```json
{
  "command": "hermes",
  "args": ["acp", "--accept-hooks"]
}
```

## Starting the Gateway

```bash
hermes gateway run          # foreground
hermes gateway restart      # restart running instance
```

## Config Locations
| File | Purpose |
|------|---------|
| `~/.hermes/config.yaml` | All settings (model, tools, display) |
| `~/.hermes/.env` | API keys + API_SERVER_ENABLED/KEY/PORT |
| `AGENTS.md` (project root) | Project context loaded by ACP sessions |

## Key Env Vars
| Variable | Value |
|----------|-------|
| `API_SERVER_ENABLED` | `true` |
| `API_SERVER_KEY` | Bearer token for auth |
| `API_SERVER_PORT` | `8642` |
| `API_SERVER_HOST` | `127.0.0.1` |
| `OPENAI_API_KEY` | Same as API_SERVER_KEY (for client libraries) |
| `OPENAI_API_BASE` | `http://localhost:8642/v1` |
