# Relatório de Testes de Carga — checklist-compras
**Data:** 2026-05-20  
**Versão testada:** branch `main` (commit mais recente)  
**Ambiente:** kind local, 1 réplica, Node.js v24, PostgreSQL 16, Redis 7

---

## Resumo Executivo

O app sustenta **20 usuários simultâneos** com latência aceitável (P99 < 1s).  
Acima de 20 usuários, o `GET /app` degrada significativamente.  
**Não houve crashes, erros HTTP ou restarts** em nenhuma fase — o app falha graciosamente degradando latência, não derrubando.

**Elo mais fraco identificado:** Knex connection pool (max:10 default) esgotado sob carga, forçando queries a enfileirar. A query SQL em si é rápida (0.13ms com índice).

---

## Dados Brutos por Fase

| Usuários | Total reqs | Erros | P95 global | P99 global | `list` avg | App CPU | PG CPU | Redis CPU |
|----------|-----------|-------|------------|------------|-----------|---------|--------|-----------|
| 5  (baseline) | 2.957 | 0 | 116ms  | 165ms  | 72ms   | ~5m   | ~15m  | ~6m  |
| 20 (ramp)     | 5.582 | 0 | 659ms  | 934ms  | 489ms  | ~200m | ~130m | ~7m  |
| 50 (stress)   | 4.447 | 0 | 2.381ms| 3.706ms| 1.753ms| 941m  | 259m  | 16m  |
| 100 (peak)    | 4.382 | 0 | 4.476ms| 5.680ms| 3.306ms| 922m  | 275m  | 14m  |

*CPU medido com kubectl top durante Phase 3 sustentada.*

### Métricas por operação — fase 50 usuários (ponto de degradação)

| Operação | P50 | P95 | P99 | Sinal |
|----------|-----|-----|-----|-------|
| `add` (INSERT) | 147ms | 379ms | 490ms | ✓ OK |
| `list` (GET /app) | 1.604ms | 3.706ms | 4.352ms | ⚠ CRÍTICO |
| `check` (UPDATE) | 296ms | 632ms | 774ms | ~ Atenção |
| `critical` (PATCH) | 320ms | 1.240ms | 1.651ms | ⚠ Atenção |
| `quantity` (PATCH) | 318ms | 1.244ms | 1.653ms | ⚠ Atenção |

---

## Ponto de Quebra

**Threshold de degradação:** ~20 usuários simultâneos → P99 passa de 165ms para 934ms (5.6× pior).  
**Degradação severa:** 50 usuários → P99 de 3.7s — ainda sem erros, mas UX comprometida.  
**Ponto de quebra prático:** 100 usuários → P99 de 5.7s + throughput cai para 7 waves/60s (vs 116 waves com 5 usuários).

O app **não crasha** mas fica lento. Não há ponto de ruptura abrupta — degradação graceful.

---

## Elo Mais Fraco

### Causa raiz: Knex connection pool esgotado

O `GET /app` executa **3 queries em paralelo** via `Promise.all`:
1. `itemService.listItems` → abre uma **transaction** (Knex pool connection)
2. `tenant_members JOIN users` → pool connection
3. `tenant_members JOIN tenants` → pool connection

Com 50 usuários simultâneos = **150 conexões** necessárias simultaneamente.  
Pool default do Knex = **max: 10 conexões**.  
→ 140 queries ficam esperando na fila do pool → latência acumula.

**Evidência:** A query SQL isolada é rápida:
```sql
EXPLAIN ANALYZE SELECT ... 
-- Execution Time: 0.134 ms  ✓
```

O problema não é a query — é a **contenção de conexões**.

### Mapa de responsabilidade

| Componente | CPU em pico | Responsabilidade no gargalo |
|-----------|-------------|----------------------------|
| **App (Node.js)** | 941m (≈1 vCPU) | Pool manager + event loop | **Principal** |
| **PostgreSQL** | 275m | Execução de queries paralelas | Secundário |
| **Redis** | 16m | Socket.IO adapter | Irrelevante |

**Redis é completamente folgado** — não é um fator limitante.  
**PostgreSQL** está saudável mas absorve impacto do pool.  
**Node.js** é o ponto de controle — o pool de conexões limita tudo.

### Função específica mais lenta

`GET /app` → `routes/items.js` linha 9-31:
```js
const [items, members, allWorkspaces] = await Promise.all([
  itemService.listItems(req.tenantId, sortBy, db),  // ← abre transação
  db('tenant_members').join('users', ...)...         // ← pool connection
  db('tenant_members').join('tenants', ...)...       // ← pool connection
]);
```

Cada request abre 3 conexões simultâneas do mesmo pool limitado.

---

## Recomendações

### 1. Aumentar o connection pool (ganho imediato)

Em `website/db.js`:
```js
const db = knex({
  client: 'pg',
  connection: { ... },
  pool: { min: 2, max: 50 },  // era default 10
});
```
**Impacto esperado:** suportar 50+ usuários sem degradação severa.

### 2. Eliminar uma das queries paralelas de GET /app

`allWorkspaces` e `ownedCount` são usados só no dropdown da navbar — não precisam ser carregados a cada GET /app. Cache por sessão JWT:
```js
// Opção A: cache no JWT (allWorkspaces muda raramente)
// Opção B: endpoint separado /workspace/list chamado apenas ao abrir o dropdown
// Opção C: passar allWorkspaces pelo Set-Cookie/localStorage
```
**Impacto:** reduz de 3 para 2 conexões por request de lista.

### 3. Adicionar PgBouncer (produção)

Para produção real com múltiplas réplicas, adicionar PgBouncer como pool externo:
- Mode: transaction pooling
- max_client_conn: 1000
- default_pool_size: 25

---

## Configurações de Resources e HPA para Helm

### Métricas observadas

| Componente | CPU idle | CPU pico (100 users) | Mem idle | Mem pico |
|-----------|----------|---------------------|----------|---------|
| App (Node.js) | 1m | 941m | 263Mi | 330Mi |
| PostgreSQL | 15m | 275m | 40Mi | 58Mi |
| Redis | 6m | 16m | 4Mi | 4Mi |

### Values para produção (1 pod, sem HPA)

```yaml
# comprasweb/values-prod.yaml
comprasweb:
  resources:
    requests:
      cpu: "250m"     # baseline confortável
      memory: "384Mi" # pico + 20% margem
    limits:
      cpu: "1000m"    # 1 vCPU — pico observado
      memory: "512Mi" # segurança contra leak

postgresql:
  resources:
    requests:
      cpu: "100m"
      memory: "64Mi"
    limits:
      cpu: "500m"
      memory: "256Mi"
```

### Values para produção com HPA (recomendado)

```yaml
# comprasweb/values-prod.yaml
comprasweb:
  replicaCount: 2  # mínimo para HA
  resources:
    requests:
      cpu: "250m"
      memory: "384Mi"
    limits:
      cpu: "1000m"
      memory: "512Mi"

hpa:
  enabled: true
  minReplicas: 2
  maxReplicas: 8
  targetCPUUtilizationPercentage: 60
  # Com 60%: scale inicia em ~600m → antes de saturar 1 vCPU
  # Cada pod suporta ~15-20 usuários sem degradação
  # 8 pods × 20 users = 160 usuários simultâneos com P99 < 1s
```

### Cálculo justificado

- 1 pod suporta ~20 usuários com P99 < 1s
- `targetCPU: 60%` → aciona scale quando CPU > 600m (antes dos 941m de pico)
- 8 réplicas máximas × 20 users = 160 usuários → margem segura para maioria dos casos
- Para escalar além, resolver o pool de conexões primeiro (item #1 das recomendações)

---

## Saúde do App Durante os Testes

- **0 crashes** — nenhum pod reiniciou
- **0 erros HTTP** — taxa de erro 0% em todas as fases
- **Redis irrelevante** — nunca passou de 16m CPU
- **Degradação graceful** — o app não cai, apenas fica lento
- **Sem memory leak detectável** — 330Mi em 100 users, retornou a 263Mi após cooldown

---

## Ações Prioritárias Antes do Go-to-Prod

| Prioridade | Ação | Impacto |
|-----------|------|---------|
| 🔴 Alta | Aumentar pool Knex: `max: 50` | +150% capacidade imediata |
| 🔴 Alta | Separar query `allWorkspaces` do GET /app | -33% conexões por request |
| 🟡 Média | Adicionar `morgan` para request logging | Observabilidade em produção |
| 🟡 Média | Configurar HPA com targetCPU: 60% | Auto-escala sob carga |
| 🟢 Baixa | PgBouncer em produção | Necessário com 3+ réplicas |

---

*Relatório gerado automaticamente após testes de carga. Próxima execução recomendada: antes do próximo release.*
