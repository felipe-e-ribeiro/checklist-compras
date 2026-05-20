# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Multi-tenant shopping list web app (lista de compras) built with Node.js/Express. Features Google OAuth authentication, JWT-based sessions (access + refresh tokens), real-time sync via Socket.IO + Redis adapter, PostgreSQL with Row Level Security (RLS) for tenant data isolation, and Node.js cluster mode (2 workers) for throughput.

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

All must be set before starting. No fallbacks for required secrets.

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | PostgreSQL connection |
| `DB_PORT` | PostgreSQL port (default 5432) |
| `REDIS_HOST` | Redis URL (default `redis://localhost:6379`) |
| `JWT_SECRET` | Signs access tokens — required, no fallback |
| `BCRYPT_ROUNDS` | bcrypt cost factor — `1` in tests, `10` in production |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 credentials |
| `GOOGLE_CALLBACK_URL` | OAuth callback — `http://localhost:3000/auth/google/callback` for local dev |
| `APP_URL` | Base URL for invite links |
| `WEB_CONCURRENCY` | Node.js cluster workers (default `2`; set `1` to disable cluster mode) |
| `LOCAL_AUTH_ENABLED` | `"true"` to enable `/access` endpoint for load testing |
| `LOCAL_AUTH_USER`, `LOCAL_AUTH_PASSWORD` | Credentials for `/access` local auth |
| `PORT` | HTTP port (default 3000) |
| `FQDN_URL`, `FQDN_USER`, `FQDN_PASSWORD` | Optional webhook on `/app/clear-checked` |

Test values are in `website/.env.test` and loaded automatically by the test runner.

## Architecture

```
website/
  server.js         — bootstrap: Express, Socket.IO (transports:websocket), Redis adapter (awaited),
                      Passport, cluster mode, route wiring
  db.js             — Knex instance, pool max:50
  knexfile.js       — DB configs for development / test / production
  middleware/
    auth.js         — makeRequireAuth(db), makeRequireTenant(db), COOKIE_OPTS (SameSite=Lax)
  routes/
    auth.js         — OAuth, /auth/refresh, /auth/logout, /privacy, /account/export, /account/delete
    access.js       — /access local auth for load testing (only when LOCAL_AUTH_ENABLED=true)
    workspace.js    — /select-workspace, /workspace/switch, /workspace/list (lazy),
                      /create-workspace, /join, /workspace/members/:userId (revoke)
    items.js        — /app/* routes + /workspace/invite + PATCH /app/item/:id
  services/
    authService.js  — JWT sign/verify, refresh token generation/hashing/rotation
    inviteService.js — create/validate/accept invite tokens (TTL: 60 seconds)
    itemService.js  — all item CRUD, each function wraps queries in a mini-transaction
    userService.js  — anonymizeUser (GDPR Art.17), exportUserData (GDPR Art.20)
  migrations/       — 9 Knex migrations (run in order, versioned by filename timestamp)
  views/            — EJS templates (login, select-workspace, create-workspace, error,
                      lista, privacy, access)
  tests/
    helpers/        — globalSetup.js, dbSetup.js (singleton test DB)
    unit/           — middleware and service tests (use real test DB)
    integration/    — migration schema tests + route tests via Supertest
comprasweb/         — Helm chart
  templates/
    deployment.yaml   — securityContext, readOnlyRootFilesystem, tmpfs
    networkpolicy.yaml — default-deny-all + explicit policies per component
    postgresql.yaml   — postgres:16-bookworm, non-root (UID 999)
    redis.yaml        — redis:7-bookworm, non-root (UID 999)
    migration-job.yaml — Helm hook, same securityContext as app
scripts/
  kind-setup.sh     — full automated kind cluster setup (7 steps incl. metrics-server + PSS labels)
docker-compose.dev.yml — postgres:5432, postgres_test:5433, redis:6379
kind-config.yaml    — kind cluster with port 80/443 mapped to host
```

## Key Design Decisions

### Authentication flow
- **Access token**: JWT (HS256, 15 min), `HttpOnly; SameSite=Lax` cookie. `SameSite=Lax` (not Strict) is required to survive OAuth redirect chains — Strict breaks cookies during Google → callback → app navigation.
- **Refresh token**: 32-byte random hex, bcrypt-hashed in `refresh_tokens` table, 30-day expiry. Rotation on every use.
- `requireAuth` auto-refreshes server-side. Falls back to redirecting `/login` (not `/auth/google`).
- **GDPR**: cookie consent checkbox on `/login` (localStorage), privacy page at `/privacy`, account deletion/anonymization via `POST /account/delete`.

### Multi-tenancy
- Business rules: max **3 owned** workspaces, max **9 total** (owned + joined). Invite TTL: **60 seconds** (single-use).
- `tenant_id` embedded in JWT after workspace selection. `requireTenant` verifies membership from DB (not JWT).
- **`items` table: FORCE RLS** — every query needs a transaction with `set_config('app.current_tenant_id', tenantId, true)`. `itemService.withTenant()` handles this.
- **`tenant_members`: RLS without FORCE** — app user (owner) bypasses it. Free queries for workspace listing without set_config.
- `allWorkspaces` is lazy-loaded via `GET /workspace/list` (called client-side only when dropdown opens) — not included in every `GET /app` to reduce connection pool pressure.

### itemService transaction pattern
Every `itemService` function uses `withTenant(tenantId, db, fn)`:
1. Opens a Knex transaction
2. Calls `set_config('app.current_tenant_id', tenantId, true)` — local to transaction
3. Executes query, auto-commits/rolls back

Always pass the global `db` (not a transaction) to services — they manage their own mini-transactions.

### Socket.IO + cluster mode
- `transports: ['websocket']` on both server and client. Polling is disabled because it round-robins across cluster workers, fragmenting sessions (each poll request might hit a different worker that doesn't know about the socket).
- Redis adapter awaited **before** server starts listening — critical for cluster mode. If the adapter is set after a socket connects, that socket's room joins go to the in-memory adapter and cross-worker events never reach it.
- `WEB_CONCURRENCY=2` by default. Never use `os.cpus().length` in containers — it returns host CPU count, not the container limit.

### server.js exports
`createApp` exported for tests is `createTestApp` — stubs `io` and skips Redis/HTTP. Cluster mode only activates via `require.main === module`.

## Database Schema

9 migrations applied in order:
1. `tenants` — `id` (UUID), `name`, `slug`, `created_at`
2. `users` — `id` (UUID), `google_id`, `email`, `name`, `avatar_url`
3. `tenant_members` — PK (`tenant_id`, `user_id`), `role`, `joined_at`. RLS enabled, no FORCE.
4. `invites` — `token`, `tenant_id`, `expires_at`, `used_at`
5. `refresh_tokens` — `token_hash`, `user_id`, `expires_at`, `revoked_at`
6. `items` — `id` (UUID), `tenant_id`, `item`, `checked`, `archived`, `archived_at`, `quantity` (varchar 25), `is_critical` (bool)
7. RLS policies — FORCE on `items`; ENABLE only on `tenant_members`
8. `users.anonymized_at` — GDPR anonymization timestamp
9. (migration 20260520000001) — `quantity` + `is_critical` columns on items

## Testing

- **Coverage**: 100% statements/branches/functions/lines enforced. Currently 136 tests across 10 suites.
- `globalSetup.js`: kills idle-in-transaction connections, unlocks migrations, runs `migrate:latest`, truncates all tables.
- `truncateAll()` kills stuck connections before TRUNCATE to avoid DDL lock conflicts with idle-in-transaction sessions.
- Unit tests for services use real test DB with explicit `set_config` transactions to exercise RLS.
- Integration route tests use Supertest. OAuth callback handler `_handleOAuthCallback` is exported for direct testing (bypasses Passport).

## Port-forward automático

**O `Stop` hook abre a porta 3000 automaticamente** após cada resposta do Claude (configurado em `.claude/settings.json`). Não é mais necessário abrir manualmente.

Se precisar abrir manualmente:
```bash
kubectl port-forward -n comprasweb-local svc/comprasweb 3000:3000
```

## Testes de carga (obrigatório antes de releases)

Use a skill `qa-load-test` antes de cada release. **Use o ingress, não o port-forward** — port-forward falha silenciosamente com 50+ usuários simultâneos.

```bash
# Pré-requisito: verificar ingress
curl -s -o /dev/null -w "%{http_code}" -H "Host: compras.localhost" http://localhost/healthz

# Protocolo completo via ingress
HOST_HEADER=compras.localhost node .claude/skills/qa-load-test/scripts/load-test.js http://localhost 5   30
HOST_HEADER=compras.localhost node .claude/skills/qa-load-test/scripts/load-test.js http://localhost 20  60
HOST_HEADER=compras.localhost node .claude/skills/qa-load-test/scripts/load-test.js http://localhost 50  60
HOST_HEADER=compras.localhost node .claude/skills/qa-load-test/scripts/load-test.js http://localhost 100 60
```

O script limpa todos os itens de teste ao final (Phase 4). Relatórios em `reports/` (gitignored).

**Limites com 1 pod, 2 workers, pool max:50:**  
≤20 usuários: P99 <1s ✓ | 50 usuários: P99 ~637ms ✓ | 100 usuários: P99 ~1s ✓

## Docker & Kubernetes

**Skills locais disponíveis** (`.claude/skills/`):
- `devsecops` — checklist de segurança obrigatório antes de qualquer push/release
- `kind-ops` — setup, redeploy, logs HTTP, metrics-server, diagnóstico
- `qa-load-test` — testes de carga, relatórios, análise de gargalos
- `workspace-ux` — regras de negócio e guardrails do sistema de workspaces

**Requisitos de segurança (não-negociáveis):**
1. Nenhum secret no repositório — apenas placeholders `"CHANGE_IN_PROD"`
2. Versões pinadas — sem `latest` em produção (`node:22-bookworm-slim`, `postgres:16-bookworm`, `redis:7-bookworm`)
3. Imagens multi-arch — suporte ARM64 + AMD64
4. NetworkPolicies — default deny-all + políticas explícitas por componente
5. Non-root — app UID 1000, postgres/redis UID 999
6. Pod Security Standards — `enforce: baseline`, `warn: restricted`
7. Filesystem read-only — `readOnlyRootFilesystem: true` no app e migration job

**Setup completo automatizado:**
```bash
bash scripts/kind-setup.sh
```

**Rebuild e redeploy (kind):**
```bash
docker build -t comprasweb-local:latest .
kind load docker-image comprasweb-local:latest --name compras
helm upgrade comprasweb ./comprasweb -f comprasweb/values-kind.yaml -n comprasweb-local --timeout 8m \
  --set comprasweb.googleClientId=... --set comprasweb.googleClientSecret=... \
  --set comprasweb.googleCallbackUrl=http://localhost:3000/auth/google/callback \
  --set comprasweb.appUrl=http://localhost:3000 \
  --set comprasweb.jwtSecret=... --set postgresql.auth.password=...
kubectl rollout status deployment/comprasweb-local -n comprasweb-local --timeout=60s
```

Google OAuth requer `http://localhost:3000/auth/google/callback` em APIs & Services → Credentials → Authorized redirect URIs.

**CI/CD** (`.github/workflows/ci.yaml`): PR/push → `test` (136 testes, 100% coverage, Postgres+Redis como services) → `trivy` (bloqueia CVEs CRITICAL) → `build-and-push` (multi-arch, só em release).
