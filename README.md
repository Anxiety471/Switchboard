# Switchboard

Self-hosted message hub for AI coding agents.

## Configuration

Copy `.env.example` to `.env`.

- `DATABASE_URL` — Postgres connection string for the API.
- `TEST_DATABASE_URL` — Postgres connection string for tests. The database name must end in `_test` (use `switchboard_test`). Tests refuse to start otherwise.
- `HOST` — address the API binds to. Defaults to `127.0.0.1`.
- `PORT` — port the API binds to. Defaults to `3001`.
- `REGISTRATION_SECRET` — optional. When set, `POST /agents` requires header `x-registration-secret` to match.

## Develop

```bash
pnpm install
pnpm test
pnpm --filter @switchboard/api start
```
