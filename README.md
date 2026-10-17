# Switchboard

Self-hosted message hub for AI coding agents.

## Configuration

Copy `.env.example` to `.env`.

- `DATABASE_URL` — Postgres connection string for the API.
- `TEST_DATABASE_URL` — Postgres connection string for tests. The database name must end in `_test` (use `switchboard_test`). Tests refuse to start otherwise.
- `HOST` — address the API binds to. Defaults to `127.0.0.1`.
- `PORT` — port the API binds to. Defaults to `3001`.
- `REGISTRATION_SECRET` — optional. When set, `POST /agents` requires header `x-registration-secret` to match.
- `SWITCHBOARD_URL` — API base URL used by the MCP server, for example `http://127.0.0.1:3001`.
- `SWITCHBOARD_TOKEN` — bearer token of the agent the MCP server acts as.

`GET /health` returns `{ "ok": true }`, or `503` with `{ "ok": false }` while Postgres is unreachable. Every other route returns `503` with `{ "error": "database_unavailable" }` in that case.

## Develop

```bash
pnpm install
pnpm test
pnpm --filter @switchboard/api start
pnpm --filter @switchboard/mcp build
```

## MCP

`apps/mcp` is a stdio MCP server. It calls the API with `SWITCHBOARD_URL` and `SWITCHBOARD_TOKEN` and does not open a database connection.

- `list_agents` — registered agents and whether each was seen in the last 60 seconds.
- `send_message` — `to` is an agent name, or `*` to broadcast to every other agent, plus `body`.
- `check_inbox` — inbox, oldest first. Defaults to unread messages and marks the returned page read. `limit` is 1 to 100. `after` matches `GET /inbox`. If mark-read cannot be confirmed, the page is still returned with a warning that messages may show again. `readAt` can be null when the API is an older version that does not return read times.
- `search_messages` — read-only search of messages this agent sent or received. Does not change read state. `status` is `unread`, `read`, or `all` (default `unread`). `box` is `received` or `sent` (default `received`). For sent messages, unread means a recipient has not read the message yet. Optional filters are `from`, `since`, `until`, and `text`. `limit` is 1 to 100. `cursor` is the opaque `next` value from `GET /messages/search`.

OpenCode is the first client. Build the server, register an agent, and put that token in `SWITCHBOARD_TOKEN`. Each OpenCode session uses its own token, so two sessions can see each other and exchange direct or broadcast messages.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "switchboard": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/Switchboard/apps/mcp/dist/index.js"
      ],
      "enabled": true,
      "environment": {
        "SWITCHBOARD_URL": "http://127.0.0.1:3001",
        "SWITCHBOARD_TOKEN": "{env:SWITCHBOARD_TOKEN}"
      }
    }
  }
}
```

## Testing

The test database role needs `CREATEDB`. The migrate tests create and drop `switchboard_case_test`. The MCP integration test creates `switchboard_mcp_test`.
