# Plano de Implementação: Multi-tenancy, Auth e CI/CD

**Spec:** `2026-05-19-multitenancy-auth-cicd-design.md`
**Data:** 2026-05-19
**Metodologia:** TDD estrito — nenhuma linha de implementação antes do teste correspondente.

---

## Ordem de execução

```
Fase 0 → Fase 1 → Fase 2 → Fase 3 → Fase 4 → Fase 5 → Fase 6 → Fase 7
Setup    Migrations  Services  Middleware  Routes   Views   Socket  CI/CD
```

Cada fase só começa após a anterior estar com testes passando.

---

## Fase 0 — Setup e infraestrutura

### 0.1 — Dependências

Adicionar ao `website/package.json`:

```json
"dependencies": {
  "passport": "^0.7",
  "passport-google-oauth20": "^2.0",
  "jsonwebtoken": "^9.0",
  "bcrypt": "^5.1",
  "cookie-parser": "^1.4"
}

"devDependencies": {
  "jest": "^29",
  "supertest": "^7",
  "@types/jest": "^29"
}
```

Remover: `express-session`, `connect-redis` (sessão não é mais Redis — só o adapter Socket.IO permanece).

Atualizar scripts em `package.json`:
```json
"test": "jest --runInBand",
"test:coverage": "jest --runInBand --coverage --coverageThreshold='{\"global\":{\"lines\":100}}'",
"test:watch": "jest --watch"
```

### 0.2 — Docker Compose para desenvolvimento

Criar `docker-compose.dev.yml` na raiz:
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: lista_compras
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
    ports: ["5432:5432"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
```

### 0.3 — Atualizar `website/db.js`

Remover configuração MySQL. Manter apenas `pg`:
```js
const knex = require('knex')({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
});
module.exports = knex;
```

### 0.4 — Configurar Jest

Criar `website/jest.config.js`:
```js
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'middleware/**/*.js',
    'routes/**/*.js',
    'services/**/*.js',
  ],
  coverageDirectory: 'coverage',
};
```

Criar `website/tests/helpers/dbSetup.js` e `website/tests/helpers/factories.js` (estrutura base, sem implementação ainda).

---

## Fase 1 — Migrations (Knex)

Cada migration é um arquivo `website/migrations/YYYYMMDDHHMMSS_<nome>.js`.

| # | Nome | O que cria |
|---|------|------------|
| 001 | `create_tenants` | tabela `tenants` |
| 002 | `create_users` | tabela `users` |
| 003 | `create_tenant_members` | tabela `tenant_members` + índice |
| 004 | `create_invites` | tabela `invites` |
| 005 | `create_refresh_tokens` | tabela `refresh_tokens` + índice |
| 006 | `create_items` | tabela `items` (UUID, tenant_id) + índice |
| 007 | `enable_rls` | RLS em `items` e `tenant_members` + policies |

**Teste de migration** (`tests/integration/migrations.test.js`):
- Aplica todas as migrations em banco de teste limpo
- Verifica existência de cada tabela via `information_schema`
- Verifica colunas obrigatórias (`tenant_id` em `items`, etc.)
- Verifica que RLS está habilitado (`pg_class.relrowsecurity = true`)
- Faz rollback e verifica remoção

---

## Fase 2 — Services (unit tests primeiro)

### 2.1 — `authService`

**Arquivo:** `website/services/authService.js`
**Testes:** `website/tests/unit/services/authService.test.js`

Funções e casos de teste:

| Função | Casos de teste |
|--------|---------------|
| `signAccessToken(payload)` | gera JWT válido com campos corretos |
| `verifyAccessToken(token)` | token válido retorna payload; expirado lança `TokenExpiredError`; inválido lança `JsonWebTokenError` |
| `generateRefreshToken()` | retorna string hex de 64 chars |
| `hashRefreshToken(token)` | retorna hash bcrypt verificável |
| `saveRefreshToken(userId, token, db)` | insere em `refresh_tokens` com hash |
| `validateRefreshToken(token, userId, db)` | token válido retorna registro; revogado retorna null; expirado retorna null; inexistente retorna null |
| `rotateRefreshToken(oldToken, userId, db)` | revoga antigo, cria novo, retorna novo token |

### 2.2 — `inviteService`

**Arquivo:** `website/services/inviteService.js`
**Testes:** `website/tests/unit/services/inviteService.test.js`

| Função | Casos de teste |
|--------|---------------|
| `createInvite(tenantId, userId, db)` | insere em `invites` com `expires_at = now + 48h`; retorna token |
| `validateInvite(token, db)` | token válido retorna invite; expirado retorna null; já usado retorna null; inexistente retorna null |
| `acceptInvite(token, userId, db)` | marca `used_at`, insere em `tenant_members`; retorna `tenantId` |

### 2.3 — `itemService`

**Arquivo:** `website/services/itemService.js`
**Testes:** `website/tests/unit/services/itemService.test.js`

| Função | Casos de teste |
|--------|---------------|
| `listItems(tenantId, sortBy, db)` | retorna apenas não-arquivados do tenant; ordena por item ou checked |
| `addItem(tenantId, itemText, db)` | insere com tenant_id correto; retorna item criado |
| `checkItem(tenantId, id, checked, db)` | atualiza apenas item do tenant; ignora items de outros tenants |
| `archiveChecked(tenantId, db)` | arquiva apenas itens checked do tenant; retorna contagem |
| `listArchived(tenantId, db)` | retorna apenas arquivados do tenant |
| `deleteArchived(tenantId, db)` | remove apenas arquivados do tenant |

> Estes testes são de integração leve (usam banco de teste real com set_config ativo).

---

## Fase 3 — Middleware (unit tests primeiro)

### 3.1 — `requireAuth`

**Arquivo:** `website/middleware/auth.js`
**Testes:** `website/tests/unit/middleware/auth.test.js`

| Caso de teste | Comportamento esperado |
|--------------|----------------------|
| Cookie `access_token` ausente | `401 { code: 'UNAUTHORIZED' }` |
| Token com assinatura inválida | `401 { code: 'UNAUTHORIZED' }` |
| Token expirado | `401 { code: 'TOKEN_EXPIRED' }` |
| Token válido | injeta `req.user = { id, email, tenantId? }`, chama `next()` |

### 3.2 — `requireTenant`

**Arquivo:** `website/middleware/auth.js` (mesma função)
**Testes:** `website/tests/unit/middleware/tenant.test.js`

| Caso de teste | Comportamento esperado |
|--------------|----------------------|
| `req.user.tenantId` ausente | `403 { code: 'FORBIDDEN' }` |
| Usuário não é membro do tenant | `403 { code: 'FORBIDDEN' }` |
| Tenant inexistente | `403 { code: 'FORBIDDEN' }` |
| Usuário membro válido | injeta `req.tenantId`, executa `set_config`, chama `next()` |

---

## Fase 4 — Rotas (integration tests primeiro)

### 4.1 — `routes/auth.js`

**Testes:** `website/tests/integration/routes/auth.routes.test.js`

| Rota | Casos de teste |
|------|---------------|
| `POST /auth/refresh` | refresh válido → novos cookies + 200; revogado → 401; expirado → 401; ausente → 401 |
| `POST /auth/logout` | revoga refresh no banco; limpa cookies; 200 |
| `GET /auth/google` | redireciona para URL do Google (mock Passport) |

> `GET /auth/google/callback` testado com mock do Passport (sem chamar Google real).

### 4.2 — `routes/workspace.js`

**Testes:** `website/tests/integration/routes/workspace.routes.test.js`

| Rota | Casos de teste |
|------|---------------|
| `GET /select-workspace` | sem auth → 401; com auth, 0 tenants → redirect /create-workspace; 1 tenant → redirect /app; N tenants → 200 com lista |
| `POST /select-workspace` | tenant válido → novo JWT com tenantId; não-membro → 403 |
| `POST /create-workspace` | cria tenant + insere owner em tenant_members; slug gerado do name |
| `GET /join?token=` | token válido + autenticado → aceita + redirect /app; expirado → 400; já usado → 400; sem auth → redirect /auth/google |
| `POST /workspace/invite` | owner → retorna inviteUrl; não-owner → 403; sem auth → 401 |

### 4.3 — `routes/items.js`

**Testes:** `website/tests/integration/routes/items.routes.test.js`

| Rota | Casos de teste |
|------|---------------|
| `GET /app` | sem auth → 401; sem tenant → 403; renderiza lista correta do tenant |
| `POST /app/add` | adiciona item ao tenant; emite Socket.IO apenas no room do tenant; item de outro tenant não aparece |
| `POST /app/check` | marca item do tenant; item de outro tenant não é afetado |
| `POST /app/clear-checked` | arquiva marcados do tenant; não arquiva de outro tenant; chama webhook |
| `DELETE /app/remove-archived` | remove arquivados do tenant apenas |
| `POST /app/check-archived` | retorna arquivados do tenant apenas |

**Teste de isolamento crítico:** criar dois tenants (A e B) com itens, verificar que as operações de A nunca afetam B e vice-versa.

---

## Fase 5 — Views EJS

Novas views necessárias:

| Arquivo | Descrição |
|---------|-----------|
| `views/login.ejs` | Botão "Entrar com Google"; redireciona para `/auth/google` |
| `views/select-workspace.ejs` | Lista de tenants do usuário + link "Criar novo" |
| `views/create-workspace.ejs` | Formulário: nome do ambiente |
| `views/error.ejs` | Mensagem de erro genérica (convite expirado, etc.) |
| `views/lista.ejs` (atualizar) | Adicionar menu de usuário (nome + logout) + link de convite para owners |

> Views não têm testes unitários diretos — cobertas pelos testes de integração de rota (resposta HTML com status 200).

---

## Fase 6 — Socket.IO (atualização)

**Arquivo:** `website/server.js` (seção Socket.IO)

Adicionar middleware de autenticação ao Socket.IO:

```js
io.use((socket, next) => {
  // 1. Parseia cookie access_token do header
  // 2. Verifica JWT via authService.verifyAccessToken
  // 3. Injeta socket.tenantId e socket.userId
  // 4. next() ou next(new Error('UNAUTHORIZED'))
});

io.on('connection', (socket) => {
  socket.join(socket.tenantId);
});
```

Atualizar todas as emissões para `io.to(tenantId).emit(...)`.

**Testes:** cobertos pelos testes de integração de rotas (verificam que o evento Socket.IO é emitido corretamente após mutations).

---

## Fase 7 — CI/CD

Substituir `.github/workflows/ci.yaml` pelo workflow aprovado no spec:

- Job `test`: Postgres 16 + Redis 7 como services, migrations, coverage 100%
- Job `trivy`: build + scan CRITICAL, falha se encontrar
- Job `build-and-push`: só em release, após test + trivy

Atualizar `Dockerfile` se necessário (remover dependências MySQL que não serão mais usadas).

---

## Checklist final

- [ ] `npm test` passa com 100% de cobertura
- [ ] `npm run migrate` funciona em Postgres limpo
- [ ] Login Google OAuth funciona end-to-end (ambiente dev)
- [ ] Dois usuários em tenants diferentes não veem dados um do outro
- [ ] Convite por link funciona (gera → abre link → aceita → acessa lista)
- [ ] Socket.IO emite apenas para o tenant correto
- [ ] Trivy sem CVEs CRITICAL na imagem final
- [ ] CI verde em PR aberto

---

## Variáveis de ambiente necessárias para dev

```env
DB_CLIENT=pg
DB_HOST=localhost
DB_USER=dev
DB_PASSWORD=dev
DB_NAME=lista_compras
REDIS_HOST=redis://localhost:6379
JWT_SECRET=dev-secret-change-in-prod
GOOGLE_CLIENT_ID=<do Google Cloud Console>
GOOGLE_CLIENT_SECRET=<do Google Cloud Console>
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
APP_URL=http://localhost:3000
PORT=3000
```
