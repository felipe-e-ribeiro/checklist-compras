# Design: Workspace Redesign — Limites, Switching e Member Management

**Data:** 2026-05-20  
**Status:** Aprovado

---

## Contexto

O sistema atual de workspaces exige que o usuário passe pela tela `/select-workspace` toda vez que quer trocar de contexto, o que interrompe o fluxo. Não há limite de criação, não há painel de membros e o sistema de convites tem TTL de 48h sem restrição de uso. Este redesign corrige tudo isso.

---

## Regras de Negócio

| Regra | Valor |
|---|---|
| Máximo de workspaces **criados** (owned) por usuário | **3** |
| Máximo de workspaces **total** (owned + joined) por usuário | **9** |
| TTL do link de convite | **60 segundos** |
| Uso do link de convite | **Uma única vez** (já implementado) |
| Owner pode se auto-revogar | **Não** |
| Owner pode revogar outro owner | **Não** |
| Owner pode revogar membro | **Sim** |

Esses limites são hardcoded na aplicação — sem configuração por workspace ou por tenant.

---

## Schema (sem migração nova)

As tabelas existentes cobrem todos os requisitos:

- `tenants`: id (UUID), name, slug, created_at
- `tenant_members`: tenant_id, user_id, role (`owner` | `member`), joined_at
- `invites`: token, tenant_id, created_by, expires_at, used_at

A única mudança é no código: `INVITE_EXPIRY_MS = 60 * 1000` em `inviteService.js`.

---

## Rotas e API

### Novas

| Método | Rota | Middleware | Descrição |
|---|---|---|---|
| `POST` | `/workspace/switch` | `requireAuth` | Emite novo JWT com `tenantId` selecionado e redireciona para `/app` |
| `DELETE` | `/workspace/members/:userId` | `requireAuth` + `requireTenant` | Owner revoga membro do workspace ativo |

### Modificadas

| Rota | Mudança |
|---|---|
| `POST /create-workspace` | Valida owned count < 3 antes de inserir |
| `GET /join?token=` | Valida total count < 9 antes de aceitar o convite |
| `POST /workspace/invite` | TTL implicitamente cai para 60s via mudança no service |
| `GET /app` | Passa `members[]` e `userRole` para o template (para o modal inline) |

### Lógica de `DELETE /workspace/members/:userId`

1. `requireTenant` confirma que o requester é membro ativo
2. Busca role do requester na tabela: deve ser `owner`
3. Rejeita com 403 se `userId === req.user.sub` (auto-revogação)
4. Rejeita com 403 se role do target é `owner` (não pode revogar outro owner)
5. `DELETE FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`
6. Retorna `200 { ok: true }`

### Lógica de `POST /workspace/switch`

1. Recebe `tenantId` no body
2. Valida membership do usuário nesse tenant (igual ao `requireTenant` atual)
3. Emite novo access token com `{ sub, email, tenantId }`
4. Seta cookie e redireciona para `/app`

---

## Componentes de UX

### Navbar — Workspace Dropdown

O nome do workspace ativo (com ícone ▾) substitui o texto estático "Lista de Compras" na navbar. Abre dropdown ao clicar. Fecha ao clicar fora ou pressionar Esc.

**Estrutura do dropdown:**
```
✓  Família Silva    Dono      ← workspace ativo (checkmark + form POST /workspace/switch)
   Trabalho         Dono
   Lista João       Membro
───────────────────────────
⚙  Gerenciar workspace       ← visível APENAS para owner do workspace ATIVO
+  Criar novo (2/3)           ← desabilitado e com texto "Limite atingido (3/3)" se owned = 3
```

- Cada workspace não-ativo é um form com `action="/workspace/switch"` e `tenantId` hidden
- O workspace ativo não tem form (já está ativo)
- "Gerenciar" abre o modal de gerenciamento
- "Criar novo" leva para `/create-workspace` (ou mostra tooltip se no limite)

### Modal de Gerenciamento

Overlay sobre o `/app`. Renderizado inline no `lista.ejs` mas oculto por CSS. Os dados de membros são pré-carregados pelo `GET /app` no template. Fecha com ✕ ou clique fora do modal.

**Estrutura:**
```
┌─────────────────────────────────────────┐
│  Família Silva                       ✕  │
├─────────────────────────────────────────┤
│  MEMBROS (N)                            │
│  Ana Silva   ana@gmail.com   Dono       │  ← sem botão de revogar
│  João Lima   joao@gmail.com  Membro  [Revogar]
│  Maria C.    maria@gmail.com Membro  [Revogar]
├─────────────────────────────────────────┤
│  CONVIDAR                               │
│  [Gerar link de convite]                │
└─────────────────────────────────────────┘
```

**Revogar — confirmação inline:**
- 1º clique: botão muda para `[Confirmar?]` com timer de 3s
- 2º clique dentro de 3s: `DELETE /workspace/members/:userId` → linha some com fade
- Sem 2º clique: volta ao estado `[Revogar]`

### Convite com Countdown de 60s

Ao clicar "Gerar link de convite":
- `POST /workspace/invite` retorna `{ inviteUrl }`
- Botão é substituído por um bloco com: URL truncada, botão "Copiar", countdown JS de 60s
- Ao zerar: área fica acinzentada com `"Link expirado"` + botão `"Gerar novo link"`
- Usuário pode gerar quantos quiser; cada um dura 60s e funciona uma única vez

### Feedback de Limites

| Situação | Comportamento |
|---|---|
| owned = 3 | "Criar novo" no dropdown mostra `"Limite atingido (3/3)"` e não é clicável |
| total = 9, abre link de convite | `GET /join` retorna `error.ejs` com mensagem clara |
| POST /create-workspace com owned = 3 | 403 `{ code: 'WORKSPACE_LIMIT_REACHED' }` |
| Link de convite acessado após 60s | `error.ejs`: "Convite inválido ou expirado." |

---

## Segurança e Edge Cases

**Membro revogado enquanto ativo:**
- Próximo request → `requireTenant` → membership não encontrada → 403
- Middleware redireciona para `/select-workspace`
- `/select-workspace` lista os workspaces restantes normalmente

**Bypass de limite via POST direto:**
- `POST /create-workspace` com owned = 3 → 403 com `code: WORKSPACE_LIMIT_REACHED`
- `GET /join` com total = 9 → render `error.ejs`
- Ambos validados server-side, não apenas na UI

**Invite TTL 60s — implicações de UX:**
- O dono DEVE compartilhar o link e o destinatário deve clicar imediatamente
- Links gerados pelo toast antigo (48h) que ainda estejam no banco e dentro do prazo de 48h NÃO são afetados (a validação usa `expires_at` do banco)
- Novos convites gerados após a mudança terão TTL de 60s

**Troca de workspace durante request em voo:**
- Se o usuário troca de workspace enquanto um request está processando, o request original conclui normalmente (o JWT validado no início do request ainda é válido)
- O próximo request já usa o novo JWT com o novo `tenantId`

---

## O que NÃO muda

- Schema do banco (nenhuma migração)
- Fluxo de login / OAuth
- Fluxo de `/create-workspace` (exceto a validação de limite)
- Socket.IO rooms por tenant
- Sistema de convite (exceto TTL)
- Testes unitários de `inviteService` (ajustes nos valores esperados de TTL)
