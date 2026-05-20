# Design: Multi-tenancy, Auth Google OAuth e CI/CD

**Data:** 2026-05-19
**Status:** Aprovado

---

## Visão geral

Evolução do app checklist-compras de lista global sem autenticação para uma plataforma multi-tenant com autenticação Google OAuth, sessão stateless via JWT, isolamento por tenant com RLS no PostgreSQL e pipeline CI/CD com cobertura 100% e varredura Trivy.

---

## Decisões tomadas

| Decisão | Escolha |
|---------|---------|
| Banco de dados | PostgreSQL self-hosted (sem Supabase) |
| Auth | Passport.js + Google OAuth |
| Sessão | JWT (15min) + refresh token (30 dias) em cookies HttpOnly |
| Isolamento de tenant | RLS no PostgreSQL via `set_config` |
| Seleção de tenant | Painel pós-login (`/select-workspace`) |
| Convites | Link com token único, expira em 48h |
| Dados existentes | Descartados — começo limpo |
| Testes | Jest + Supertest, cobertura 100% |

---

## 1. Modelo de dados

### Schema PostgreSQL

```sql
-- Ambientes (tenants)
tenants
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
  name        TEXT NOT NULL
  slug        TEXT NOT NULL UNIQUE
  created_at  TIMESTAMPTZ DEFAULT now()

-- Contas de usuário (via Google)
users
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
  google_id   TEXT NOT NULL UNIQUE
  email       TEXT NOT NULL UNIQUE
  name        TEXT
  avatar_url  TEXT
  created_at  TIMESTAMPTZ DEFAULT now()

-- Membros por tenant
tenant_members
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE
  role        TEXT NOT NULL DEFAULT 'member'  -- 'owner' | 'member'
  joined_at   TIMESTAMPTZ DEFAULT now()
  PRIMARY KEY (tenant_id, user_id)

-- Convites por link
invites
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE
  token       TEXT NOT NULL UNIQUE
  created_by  UUID REFERENCES users(id)
  expires_at  TIMESTAMPTZ NOT NULL
  used_at     TIMESTAMPTZ  -- NULL = ainda válido

-- Refresh tokens (stateless auth)
refresh_tokens
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE
  token_hash  TEXT NOT NULL UNIQUE   -- hash bcrypt do token real
  expires_at  TIMESTAMPTZ NOT NULL
  revoked_at  TIMESTAMPTZ            -- NULL = válido
  created_at  TIMESTAMPTZ DEFAULT now()

-- Itens da lista
items
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
  item        TEXT NOT NULL
  checked     BOOLEAN NOT NULL DEFAULT false
  archived    BOOLEAN NOT NULL DEFAULT false
  archived_at TIMESTAMPTZ
  created_at  TIMESTAMPTZ DEFAULT now()
```

### Índices

```sql
CREATE INDEX ON items (tenant_id, archived);
CREATE INDEX ON tenant_members (user_id);
CREATE INDEX ON refresh_tokens (user_id, revoked_at);
```

### Row Level Security

```sql
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON items
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_member_isolation ON tenant_members
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

O middleware injeta o `tenant_id` via `SELECT set_config('app.current_tenant_id', $1, true)` antes de cada query nas rotas protegidas.

---

## 2. Autenticação (JWT + Refresh Token)

### Tokens

- **Access token:** JWT assinado (HS256), payload `{ sub: userId, email, tenantId? }`, expira em **15 minutos**, cookie `access_token` — `HttpOnly; Secure; SameSite=Strict`. O campo `tenantId` está ausente logo após o login e é adicionado ao payload quando o usuário seleciona um workspace em `/select-workspace`.
- **Refresh token:** 32 bytes aleatórios (hex), hash bcrypt armazenado em `refresh_tokens`, expira em **30 dias**, cookie `refresh_token` — `HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh`.

### Fluxo de login

```
GET /auth/google
  → redireciona para Google consent screen

GET /auth/google/callback
  → Passport.js valida code
  → busca ou cria user (por google_id)
  → gera access token (JWT, sem tenantId ainda)
  → gera refresh token (salva hash no banco)
  → seta cookies HttpOnly
  → redireciona para /select-workspace
```

### Fluxo de refresh (transparente ao usuário)

```
Request com access token expirado
  → middleware retorna 401 { code: 'TOKEN_EXPIRED' }
  → frontend chama POST /auth/refresh
  → valida refresh token: hash match + not revoked + not expired
  → revoga token antigo (revoked_at = now())
  → gera novo par access + refresh (rotation)
  → seta novos cookies
  → frontend retenta request original
```

### Logout

```
POST /auth/logout
  → revoga refresh token no banco
  → limpa cookies access_token e refresh_token
```

### Middleware `requireAuth`

1. Lê cookie `access_token`
2. Verifica assinatura JWT e expiração
3. Expirado → `401 { code: 'TOKEN_EXPIRED' }`
4. Inválido → `401 { code: 'UNAUTHORIZED' }`
5. Válido → injeta `req.user = { id, email }`, chama `next()`

---

## 3. Multi-tenancy

### Seleção de tenant pós-login

```
GET /select-workspace
  → lista tenants do usuário (tenant_members JOIN tenants WHERE user_id = req.user.id)
  → 0 tenants → redireciona /create-workspace
  → 1 tenant  → seleciona automaticamente, redireciona /app
  → N tenants → renderiza painel de seleção

POST /select-workspace  { tenantId }
  → verifica membership
  → emite novo access token com tenantId no payload
  → seta cookie atualizado
  → redireciona /app
```

### Middleware `requireTenant`

Executa após `requireAuth` em todas as rotas `/app/*` e `/workspace/*`:

1. Extrai `tenantId` do JWT (`req.user.tenantId`)
2. Verifica membership: `SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND user_id=$2`
3. Não-membro → `403 { code: 'FORBIDDEN' }`
4. Injeta `req.tenantId`
5. Executa `SELECT set_config('app.current_tenant_id', tenantId, true)` — ativa RLS
6. `next()`

### Fluxo de convite

```
POST /workspace/invite  (owner only — enforced: verifica role='owner' em tenant_members; não-owner recebe 403)
  → gera token = crypto.randomBytes(32).toString('hex')
  → salva em invites { tenant_id, token, expires_at: now + 48h, created_by }
  → retorna { inviteUrl: APP_URL + '/join?token=<token>' }

GET /join?token=<token>
  → não autenticado → /auth/google?next=/join?token=<token>
  → valida invite: exists + used_at IS NULL + expires_at > now()
  → inválido/expirado → 400 com mensagem de erro
  → insere tenant_members { tenant_id, user_id, role: 'member' }
  → marca invite: used_at = now()
  → emite novo JWT com tenantId
  → redireciona /app
```

### Socket.IO com isolamento de tenant

O cookie `access_token` é HttpOnly — o frontend JS não consegue lê-lo. Por isso, o join no room é feito via middleware server-side do Socket.IO, que lê o cookie e verifica o JWT na hora da conexão:

```js
io.use((socket, next) => {
  const token = socket.request.headers.cookie; // parse access_token
  const payload = verifyJwt(token);            // lança se inválido
  socket.tenantId = payload.tenantId;
  next();
});

io.on('connection', (socket) => {
  socket.join(socket.tenantId);
});

// Emissão isolada por tenant (no handler de rota)
io.to(tenantId).emit('item-added', newItem);
```

O cliente não precisa conhecer o tenantId — o servidor o extrai do cookie.

---

## 4. Rotas da aplicação

### Estrutura de arquivos

```
website/
  server.js
  db.js
  middleware/
    auth.js        ← requireAuth, requireTenant
  routes/
    auth.js        ← /auth/*
    workspace.js   ← /select-workspace, /create-workspace, /join
    items.js       ← /app/*
  services/
    authService.js
    inviteService.js
    itemService.js
```

### Rotas de auth (sem middleware)

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/auth/google` | Inicia OAuth |
| `GET` | `/auth/google/callback` | Callback Google |
| `POST` | `/auth/refresh` | Renova tokens |
| `POST` | `/auth/logout` | Revoga refresh token |

### Rotas de workspace (`requireAuth`)

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/select-workspace` | Lista tenants |
| `POST` | `/select-workspace` | Seleciona tenant ativo |
| `GET` | `/create-workspace` | Formulário de criação |
| `POST` | `/create-workspace` | Cria tenant + owner |
| `GET` | `/join` | Aceita convite |

### Rotas da lista (`requireAuth` + `requireTenant`)

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET` | `/app` | Renderiza lista |
| `POST` | `/app/add` | Adiciona item |
| `POST` | `/app/check` | Marca/desmarca item |
| `POST` | `/app/clear-checked` | Arquiva marcados + webhook |
| `DELETE` | `/app/remove-archived` | Remove arquivados |
| `POST` | `/app/check-archived` | Lista arquivados (JSON) |
| `GET` | `/workspace/invite` | Gera link de convite |

---

## 5. Testes

### Framework e setup

- **Jest** + **Supertest**
- Banco de testes: PostgreSQL em Docker Compose (`lista_compras_test`)
- Migrations aplicadas no `beforeAll`, rollback no `afterAll`
- Fixtures criadas via factories (`tests/helpers/factories.js`)

### Estrutura

```
website/tests/
  unit/
    services/
      authService.test.js
      inviteService.test.js
      itemService.test.js
    middleware/
      auth.test.js
      tenant.test.js
  integration/
    routes/
      auth.routes.test.js
      workspace.routes.test.js
      items.routes.test.js
  helpers/
    dbSetup.js
    factories.js
```

### Cobertura obrigatória

| Camada | Casos a cobrir |
|--------|---------------|
| `authService` | JWT sign/verify, refresh válido, revogado, expirado, rotation |
| `inviteService` | Token gerado corretamente, expirado, já usado |
| `requireAuth` | Cookie ausente, token inválido, expirado, válido |
| `requireTenant` | Membro válido, não-membro, tenant inexistente, RLS ativo |
| `items.routes` | CRUD completo, isolamento (tenant A ≠ tenant B) |
| `workspace.routes` | Create, select, invite end-to-end |

Cobertura mínima: **100% linhas** — CI falha se abaixo disso.

---

## 6. CI/CD

### Workflow (`.github/workflows/ci.yaml`)

Trigger: pull_request → main, push → main, release publicado.

**Job `test`:** Postgres 16 + Redis 7 como services. Aplica migrations. Roda `npm run test:coverage`. Verifica 100% de cobertura via script inline.

**Job `trivy`:** Depende de `test`. Builda imagem Docker. Roda Trivy com `exit-code: 1` para CVEs CRITICAL. Nenhum CVE crítico não-corrigido passa.

**Job `build-and-push`:** Depende de `test` + `trivy`. Só roda em release. Publica imagem multi-arch (`linux/amd64`, `linux/arm64`) no Docker Hub com tags `latest` e o tag do release.

### Regras

- PRs validam testes + Trivy, **não fazem deploy**
- Push para `main` valida testes + Trivy, **não faz deploy**
- Deploy ocorre **apenas em release publicado** após ambos passarem

---

## 7. O que NÃO muda

- Redis permanece obrigatório (Socket.IO adapter + pub/sub)
- EJS como template engine
- Knex como query builder (troca driver para `pg`)
- Helm chart e Kubernetes (sem alterações neste escopo)
- Webhook no `/app/clear-checked` (comportamento preservado)
- Variáveis de ambiente `FQDN_URL`, `FQDN_USER`, `FQDN_PASSWORD`

### Novas variáveis de ambiente obrigatórias

| Variável | Propósito |
|----------|-----------|
| `GOOGLE_CLIENT_ID` | OAuth app Google |
| `GOOGLE_CLIENT_SECRET` | OAuth app Google |
| `GOOGLE_CALLBACK_URL` | URL de callback (ex: `https://app.exemplo.com/auth/google/callback`) |
| `JWT_SECRET` | Chave de assinatura dos access tokens |
| `APP_URL` | URL base da aplicação (para gerar invite links) |

---

## Estado final esperado

- [ ] Schema PostgreSQL com todas as tabelas e RLS habilitado
- [ ] Migrations versionadas via Knex
- [ ] Google OAuth funcionando com Passport.js
- [ ] JWT (15min) + refresh token (30 dias) com rotation
- [ ] Sessão persistente — sem re-login desnecessário
- [ ] Multi-tenancy com isolamento RLS verificado em testes
- [ ] Sistema de convite por link (48h de validade)
- [ ] Cobertura de testes em 100% (linhas)
- [ ] Trivy passando sem CVEs CRITICAL
- [ ] CI/CD validando em PRs e deployando apenas em releases
