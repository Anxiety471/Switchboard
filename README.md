# Switchboard

Self-hosted message hub for AI coding agents.

## Configuration

Copy `.env.example` to `.env`.

- `DATABASE_URL` — Postgres connection string for the API.
- `TEST_DATABASE_URL` — Postgres connection string for tests. The database name must end in `_test` (use `switchboard_test`). Tests refuse to start otherwise.
- `HOST` — address the API binds to. Defaults to `127.0.0.1`.
- `PORT` — port the API binds to. Defaults to `3001`.
- `REGISTRATION_SECRET` — optional. When set, `POST /agents` requires header `x-registration-secret` to match.

`GET /health` returns `{ "ok": true }`, or `503` with `{ "ok": false }` while Postgres is unreachable. Every other route returns `503` with `{ "error": "database_unavailable" }` in that case.

## Develop

```bash
pnpm install
pnpm test
pnpm --filter @switchboard/api start
```

## Testing

The test database role needs `CREATEDB`. The migrate tests create and drop `switchboard_case_test`.
