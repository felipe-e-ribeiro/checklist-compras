# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Shopping checklist web app (lista de compras) built with Node.js/Express. Features real-time sync across clients via Socket.IO + Redis adapter, session storage in Redis, and persistence in MySQL/MariaDB (PostgreSQL also supported).

## Commands

```bash
# Install dependencies
cd website && npm install

# Run in development (with auto-reload)
cd website && npm run dev

# Run in production
cd website && npm start

# Database migrations
cd website && npm run migrate
cd website && npm run rollback
```

## Environment Variables

The app reads these at runtime — all must be set before starting:

| Variable | Default | Purpose |
|---|---|---|
| `DB_CLIENT` | `mysql2` | `mysql2` or `pg` |
| `DB_HOST` | — | Database host |
| `DB_USER` | — | Database user |
| `DB_PASSWORD` | — | Database password |
| `DB_NAME` | — | Database name |
| `REDIS_HOST` | `redis://localhost:6379` | Redis URL |
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | `seuSegredoAqui` | Express session secret |
| `FQDN_URL` | — | Webhook URL called on `/clear-checked` |
| `FQDN_USER` | — | Webhook basic auth username |
| `FQDN_PASSWORD` | — | Webhook basic auth password |

## Architecture

```
website/
  server.js   — Express app, Socket.IO server, all HTTP routes
  db.js       — Knex client (configured via env vars above)
  views/      — EJS templates
  public/     — Static assets (CSS)
db/
  lista_compras.sql  — Initial schema dump (MariaDB)
```

**Data model** (`items` table): `id`, `item` (text), `checked` (bool), `archived` (bool), `archived_at` (timestamp).

**Real-time flow**: every mutating route emits a Socket.IO event (`item-added`, `item-checked`, `items-cleared`) that clients listen to for live updates without page reload.

**`/clear-checked` route**: archives checked items (sets `archived=true`), then calls the external webhook at `FQDN_URL` with basic auth. The webhook call goes through `http://localhost:PORT/trigger-webhook` internally.

## Docker & Kubernetes

**Build image** (multi-arch, published to `feliperibeiro95/checklist-compras`):
```bash
docker build -t feliperibeiro95/checklist-compras:latest .
```
The Dockerfile copies `./website` to `/opt/website` and runs `node server.js`.

**Helm chart** (`comprasweb/`): deploy to Kubernetes using environment-specific values files.
```bash
helm upgrade --install comprasweb ./comprasweb -f comprasweb/values-dev.yaml
helm upgrade --install comprasweb ./comprasweb -f comprasweb/values-prod.yaml
```

DB credentials are stored in a Kubernetes Secret (`compras-db-secret-<env>`) rendered from `values.comprasweb.dbaccess`. The Helm deployment injects them as `MYSQL_HOST` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DB` — note these differ from the app's expected `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` env var names (existing discrepancy).

**CI/CD**: GitHub Actions (`.github/workflows/ci.yaml`) triggers on GitHub release publication, builds and pushes multi-arch images (`linux/amd64`, `linux/arm64`) tagged with `latest` and the release tag.
