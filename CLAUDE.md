# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Multi-tenant shopping list web app (lista de compras) built with Node.js/Express. Features Google OAuth authentication, JWT-based sessions (access + refresh tokens), real-time sync via Socket.IO + Redis adapter, and PostgreSQL with Row Level Security (RLS) for tenant data isolation.

## Commands

```bash
# Install dependencies
cd website && npm install

# Development (auto-reload)
cd website && npm run dev

# Production
cd website && npm start

# Migrations
cd website && npm run migrate
cd website && npm run rollback

# Tests (requires postgres_test container on port 5433)
cd website && npm test                # run without coverage
cd website && npm run test:coverage   # run with 100% coverage enforcement
cd website && npm run test:local      # starts postgres_test container then runs tests

# Run a single test file
cd website && npx jest tests/unit/services/authService.test.js --no-coverage --forceExit

# Run a single test by name
cd website && npx jest --testNamePattern="returns record for valid token" --no-coverage --forceExit
```

## Environment Variables

All must be set before starting. No fallbacks for required secrets (`JWT_SECRET`, `BCRYPT_ROUNDS`, `GOOGLE_*`).

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | PostgreSQL connection |
| `DB_PORT` | PostgreSQL port (default 5432) |
| `REDIS_HOST` | Redis URL (default `redis://localhost:6379`) |
| `JWT_SECRET` | Signs access tokens — required, no fallback |
| `BCRYPT_ROUNDS` | bcrypt cost factor — use `1` in tests, `10` in production |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 credentials |
| `GOOGLE_CALLBACK_URL` | OAuth callback — use `http://localhost:3000/auth/google/callback` for local dev |
| `APP_URL` | Base URL for generating invite links |
| `PORT` | HTTP port (default 3000) |
| `FQDN_URL`, `FQDN_USER`, `FQDN_PASSWORD` | Optional webhook called on `/app/clear-checked` |

Test values are in `website/.env.test` and loaded automatically by the test runner.

## Architecture

```
website/
  server.js         — bootstrap: Express, Socket.IO, Redis adapter, Passport, route wiring
  db.js             — Knex instance (reads NODE_ENV to pick knexfile config)
  knexfile.js       — DB configs for development / test / production
  middleware/
    auth.js         — makeRequireAuth(db), makeRequireTenant(db), COOKIE_OPTS
  routes/
    auth.js         — /auth/google, /auth/google/callback, /auth/refresh, /auth/logout
    workspace.js    — /select-workspace, /create-workspace, /join (invite acceptance)
    items.js        — /app/* routes + /workspace/invite
  services/
    authService.js  — JWT sign/verify, refresh token generation/hashing/rotation
    inviteService.js — create/validate/accept invite tokens
    itemService.js  — all item CRUD, each function wraps queries in a mini-transaction
  migrations/       — 7 Knex migrations (run in order, versioned by filename timestamp)
  views/            — EJS templates (login, select-workspace, create-workspace, error, lista)
  tests/
    helpers/        — globalSetup.js, dbSetup.js (singleton test DB), factories.js
    unit/           — middleware and service tests (use real test DB)
    integration/    — migration schema tests + route tests via Supertest
comprasweb/         — Helm chart for Kubernetes deployment
docker-compose.dev.yml — local postgres (5432) + postgres_test (5433) + redis (6379)
kind-config.yaml    — kind cluster config with port 80/443 mapped to host
```

## Key Design Decisions

### Authentication flow
- **Access token**: JWT (HS256, 15 min), stored in `HttpOnly; SameSite=Strict` cookie.
- **Refresh token**: 32-byte random hex, bcrypt-hashed in `refresh_tokens` table, 30-day expiry. Rotation on every use (old token revoked, new token issued).
- `requireAuth` auto-refreshes transparently on the server side when the access token is expired — no client-side JS needed. Falls back to redirecting `/auth/google` when both tokens are invalid.

### Multi-tenancy
- Two levels: **tenant** (workspace) and **user** (member of one or more tenants).
- `tenant_id` is embedded in the JWT payload after workspace selection at `/select-workspace`.
- `requireTenant` reads `tenant_id` from the JWT, verifies membership in `tenant_members` (no RLS on this table — the app user owns it and bypasses RLS), then injects `req.tenantId`.
- **`items` table has FORCE ROW LEVEL SECURITY** — every query must run inside a transaction with `SET set_config('app.current_tenant_id', tenantId, true)` or it returns no rows. `itemService` handles this internally via `withTenant(tenantId, db, fn)`.
- **`tenant_members` has RLS enabled but NOT FORCE** — the app user (table owner) bypasses it, allowing free queries for workspace listing without set_config.

### itemService transaction pattern
Every `itemService` function uses `withTenant(tenantId, db, fn)` which:
1. Opens a Knex transaction
2. Calls `set_config('app.current_tenant_id', tenantId, true)` — local to the transaction
3. Executes the query inside the transaction
4. Auto-commits on return, auto-rolls back on throw

Never pass a long-lived transaction to services — always pass the global `db` and let the service manage its own mini-transaction.

### Socket.IO isolation
Each client joins a room keyed by `tenantId`. The Socket.IO middleware reads the `access_token` cookie from the handshake headers and verifies the JWT server-side. All item events (`item-added`, `item-checked`) are emitted via `io.to(tenantId).emit(...)`.

### server.js exports
`server.js` exports `createApp` which is actually `createTestApp` — a version that stubs `io` with a no-op and skips Redis/HTTP setup. This is what tests import. The real server only starts when `require.main === module`.

## Database Schema

7 migrations applied in order:
1. `tenants` — `id` (UUID), `name`, `slug` (unique), `created_at`
2. `users` — `id` (UUID), `google_id` (unique), `email` (unique), `name`, `avatar_url`
3. `tenant_members` — PK (`tenant_id`, `user_id`), `role` ('owner'|'member'), `joined_at`. RLS enabled, no FORCE.
4. `invites` — `token` (unique), `tenant_id`, `created_by`, `expires_at`, `used_at`
5. `refresh_tokens` — `token_hash` (unique), `user_id`, `expires_at`, `revoked_at`
6. `items` — `id` (UUID), `tenant_id`, `item`, `checked`, `archived`, `archived_at`
7. RLS policies — ENABLE + FORCE on `items` (`tenant_isolation` policy); ENABLE only on `tenant_members` (`tenant_member_isolation` policy)

## Testing

- **Coverage threshold**: 100% statements, branches, functions, lines enforced by Jest.
- `globalSetup.js` runs once before all suites: kills idle-in-transaction connections, unlocks migrations, runs `migrate:latest`, truncates all tables.
- `dbSetup.js` provides a singleton test DB connection. `truncateAll()` kills stuck connections before truncating to avoid DDL lock conflicts.
- Unit tests for services use the real test DB (not mocks) — they exercise the actual RLS behavior via mini-transactions.
- Integration route tests use Supertest against the full Express app with a real DB.
- The OAuth callback handler `_handleOAuthCallback` is exported from `routes/auth.js` for direct testing, bypassing Passport.

## Testes de carga (obrigatório antes de releases)

Use a skill `qa-load-test` (`.claude/skills/qa-load-test/`) antes de cada release:

```bash
# Pré-requisito: port-forward ativo
kubectl port-forward -n comprasweb-local svc/comprasweb 3000:3000 &

# Protocolo completo (4 fases)
node .claude/skills/qa-load-test/scripts/load-test.js http://localhost:3000 5   30  # baseline
node .claude/skills/qa-load-test/scripts/load-test.js http://localhost:3000 20  60  # ramp
node .claude/skills/qa-load-test/scripts/load-test.js http://localhost:3000 50  60  # stress
node .claude/skills/qa-load-test/scripts/load-test.js http://localhost:3000 100 60  # peak
```

**Limites conhecidos (single pod):** ≤20 usuários P99 <1s ✓ | 50 usuários P99 ~4s ⚠ | 100 usuários P99 ~6s ⚠  
**Elo mais fraco:** Knex pool (max:10) + `GET /app` abre 3 conexões simultâneas.  
**Fix prioritário:** `pool: { max: 50 }` em `db.js` + separar query `allWorkspaces` do GET /app.

## Docker & Kubernetes

**Build image** (uses `node:lts` Debian — Alpine causes musl/glibc bcrypt incompatibility):
```bash
docker build -t feliperibeiro95/checklist-compras:latest .
```
The `.dockerignore` excludes `website/node_modules` — native modules must be compiled inside the container.

**Local kind cluster** (requires kind, kubectl, helm):
```bash
# Create cluster (port 80/443 mapped to host)
kind create cluster --config kind-config.yaml

# Install nginx ingress controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
kubectl wait --namespace ingress-nginx --for=condition=ready pod --selector=app.kubernetes.io/component=controller --timeout=90s

# Load images (postgres:16 and redis:7 must be pre-pulled)
docker build -t comprasweb-local:latest .
kind load docker-image comprasweb-local:latest --name compras
kind load docker-image postgres:16 --name compras
kind load docker-image redis:7 --name compras

# Deploy (migrations run automatically as a Helm hook post-install/upgrade)
kubectl create namespace comprasweb-local
helm upgrade --install comprasweb ./comprasweb -f comprasweb/values-kind.yaml -n comprasweb-local \
  --set comprasweb.googleClientId=YOUR_ID \
  --set comprasweb.googleClientSecret=YOUR_SECRET \
  --set comprasweb.googleCallbackUrl=http://localhost:3000/auth/google/callback \
  --set comprasweb.appUrl=http://localhost:3000

# Port-forward for Google OAuth compatibility (Google requires localhost for HTTP)
kubectl port-forward -n comprasweb-local svc/comprasweb 3000:3000
```

Google OAuth requires `http://localhost:3000/auth/google/callback` to be registered in Google Cloud Console → APIs & Services → Credentials → Authorized redirect URIs.

**Helm chart** (`comprasweb/`): includes templates for Deployment, Service, Ingress, Secret, HPA (disabled by default), ServiceAccount, RBAC, PostgreSQL StatefulSet, Redis Deployment, and migration Job (Helm hook). Credentials are passed via `--set` at deploy time, not stored in `values-kind.yaml`.

**CI/CD**: `.github/workflows/ci.yaml` triggers on PR/push to main and on release publication. Jobs: `test` (Postgres 16 + Redis 7 as services, 100% coverage enforced) → `trivy` (blocks on CRITICAL CVEs) → `build-and-push` (multi-arch `linux/amd64`+`linux/arm64`, only on release).
