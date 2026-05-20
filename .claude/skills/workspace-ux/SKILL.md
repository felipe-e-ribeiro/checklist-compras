---
name: workspace-ux
description: >
  Guia obrigatório para qualquer implementação relacionada a workspaces no projeto
  checklist-compras. Use esta skill sempre que estiver criando, modificando ou
  corrigindo qualquer feature que envolva: criação de workspace, troca de workspace,
  gestão de membros, convites, limites de workspaces, revogação de acesso, o dropdown
  de workspace na navbar, o modal de gerenciamento, ou o fluxo de /join. Mesmo que a
  tarefa pareça simples (ex: "adicionar um campo ao workspace"), consulte esta skill
  primeiro — os guardrails de segurança são não-negociáveis.
---

# Workspace UX — Regras, Guardrails e Padrões de Código

Este projeto tem um sistema de workspaces multi-tenant com regras de negócio e
segurança bem definidas. Toda implementação deve seguir este documento.

## Regras de Negócio (hardcoded, sem exceções)

| Regra | Valor |
|---|---|
| Máximo de workspaces **criados** (owned) por usuário | **3** |
| Máximo de workspaces **total** (owned + joined) por usuário | **9** |
| TTL do link de convite | **60 segundos** |
| Usos do link de convite | **1 (single-use)** |
| Owner pode se auto-revogar | **Não** |
| Owner pode revogar outro owner | **Não** |
| Owner pode revogar membro | **Sim** |

Esses limites são constantes no código. Nunca os parametrize por workspace, tenant
ou usuário sem aprovação explícita do usuário deste projeto.

## Guardrails de Segurança

**Sempre valide server-side.** A UI pode esconder botões ou desabilitar campos, mas
isso é apenas UX — o servidor é a autoridade. Todo endpoint que envolva limites
deve checar no banco antes de agir.

```js
// Limite de criação — em POST /create-workspace
const [{ count }] = await db('tenant_members')
  .where({ user_id: req.user.sub, role: 'owner' })
  .count('* as count');
if (parseInt(count) >= 3) {
  return res.status(403).json({ code: 'WORKSPACE_LIMIT_REACHED' });
}

// Limite de adesão — em GET /join
const [{ count }] = await db('tenant_members')
  .where({ user_id: req.user.sub })
  .count('* as count');
if (parseInt(count) >= 9) {
  return res.render('error', { message: 'Você já participa de 9 workspaces, o máximo permitido.' });
}
```

**Nunca confie em dados do cliente para determinar permissão.** O `tenantId` ativo
vem do JWT (server-issued), não do body do request. O `role` de um usuário sempre
vem do banco — nunca de um campo enviado pelo cliente.

**Revogar membro — checagens obrigatórias em `DELETE /workspace/members/:userId`:**
1. Requester deve ter `role = 'owner'` no banco (não no JWT)
2. `userId !== req.user.sub` (auto-revogação proibida)
3. Target não pode ter `role = 'owner'` (owners só saem deletando o workspace)
4. Ambas as checagens no banco, dentro do `requireTenant` context

## Padrão de Código para Novos Endpoints

Todo endpoint de workspace segue este padrão:

```js
router.post('/workspace/algo', requireAuth, requireTenant, async (req, res) => {
  // 1. Verificar role no banco (nunca no JWT)
  const member = await db('tenant_members')
    .where({ tenant_id: req.tenantId, user_id: req.user.sub })
    .first();
  if (!member || member.role !== 'owner') {
    return res.status(403).json({ code: 'FORBIDDEN' });
  }

  // 2. Validar limites server-side
  // ...

  // 3. Agir — usando db (global) para tenant_members (sem FORCE RLS)
  // e req.db (transaction) para items (com FORCE RLS)
});
```

**Por que `db` para `tenant_members` e `req.db` para `items`?**
- `items` tem `FORCE ROW LEVEL SECURITY` — toda query precisa de `set_config` ativo,
  que o `requireTenant` já injetou em `req.db` (uma transaction com set_config)
- `tenant_members` tem RLS sem FORCE — o app user (dono da tabela) acessa diretamente

## Componentes de UX — O que existe e como funciona

### Dropdown de Workspace (navbar)

O nome do workspace ativo na navbar é um trigger de dropdown. Ao clicar:
- Lista todos os workspaces do usuário (com checkmark no ativo)
- Cada workspace não-ativo é um form POST para `/workspace/switch`
- **Owners do workspace ativo** veem a opção "⚙ Gerenciar workspace" que abre o modal
- "Criar novo" mostra o contador `(N/3)` e fica desabilitado se owned = 3
- O dropdown fecha ao clicar fora ou pressionar Esc

### Modal de Gerenciamento

Overlay sobre `/app`, renderizado inline no `lista.ejs` com dados pré-carregados
pelo `GET /app`. O `GET /app` passa `members[]` e `userRole` para o template.

```js
// Em routes/items.js, dentro do handler GET /app:
const members = await db('tenant_members')
  .join('users', 'users.id', 'tenant_members.user_id')
  .where('tenant_members.tenant_id', req.tenantId)
  .select('users.id', 'users.name', 'users.email', 'tenant_members.role');

res.render('lista', {
  items, sortBy, user: req.user,
  tenantId: req.tenantId,
  members,
  userRole: members.find(m => m.id === req.user.sub)?.role,
});
```

O modal mostra:
- Nome do workspace + botão fechar (✕)
- Lista de membros: nome, email, badge de role, botão [Revogar] (não aparece para owners)
- Seção de convite: botão "Gerar link" que dispara o countdown

### Confirmação Inline de Revogação

**Nunca use `confirm()` do browser.** A confirmação é inline no botão:
1. 1º clique → botão muda para `[Confirmar?]` + timer de 3s no JS
2. 2º clique dentro de 3s → `DELETE /workspace/members/:userId` + remove linha com fade
3. Sem 2º clique → botão volta ao estado `[Revogar]` após 3s

### Convite com Countdown de 60 Segundos

Ao clicar "Gerar link de convite":
1. `POST /workspace/invite` retorna `{ inviteUrl }`
2. UI mostra: URL truncada + botão "Copiar" + countdown JS de 60s
3. Ao zerar: área fica cinza com `"Link expirado"` + botão `"Gerar novo link"`

O usuário pode gerar quantos links quiser — cada um é independente, expira em 60s
e funciona uma única vez. Isso é design intencional de segurança (link fresh por sessão).

O TTL é controlado por `INVITE_EXPIRY_MS = 60 * 1000` em `services/inviteService.js`.
**Não altere este valor sem atualizar também o countdown visual na UI.**

## Edge Cases Críticos

**Membro revogado enquanto ativo:** `requireTenant` detecta na próxima request →
retorna 403 → middleware redireciona para `/select-workspace` → lista workspaces
restantes. O usuário não perde dados, apenas perde acesso ao workspace revogado.

**Troca de workspace:** POST para `/workspace/switch` emite novo JWT com novo
`tenantId`, seta cookie, redireciona para `/app`. Os dados do workspace anterior
ficam seguros (RLS garante isolamento). O novo workspace carrega sua própria lista.

**Invite TTL:** A validação é `expires_at > now()` no banco. Não há lógica de
"aviso em breve" — o link ou é válido ou não é. O countdown na UI é apenas visual.

## Spec Completo

Para detalhes de arquitetura e decisões de design, leia:
`docs/superpowers/specs/2026-05-20-workspace-redesign-design.md`
