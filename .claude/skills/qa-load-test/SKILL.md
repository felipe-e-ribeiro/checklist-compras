---
name: qa-load-test
description: >
  Skill obrigatória de testes de carga para o projeto checklist-compras.
  Use esta skill antes de cada release (kind, staging ou produção) para validar
  performance, identificar gargalos e definir limites de recursos do Helm.
  Dispare sempre que o usuário mencionar: "teste de carga", "load test", "quantas
  requisições aguenta", "limits do helm", "autoscaling", "degradação", "gargalo",
  "ponto de quebra", "k8s resources", ou quiser validar uma versão antes de ir
  para produção. A skill inclui um script Node.js pronto para rodar.
---

# QA Load Test — checklist-compras

Testa carga do app em Kubernetes, identifica o elo mais fraco e recomenda
configurações de resources/HPA para o Helm. Roda via script Node.js puro
(sem npm install) mais monitoramento paralelo de logs e métricas.

## Pré-requisitos

```bash
# 1. Cluster kind rodando
kind get clusters   # deve mostrar "compras"

# 2. Port-forward ativo
kubectl port-forward -n comprasweb-local svc/comprasweb 3000:3000 &

# 3. LOCAL_AUTH_ENABLED=true no deployment (padrão no kind)
curl -s http://localhost:3000/access | grep -c "Acesso"  # deve retornar 1
```

Para produção, troque a URL e use `--url https://seu-dominio.com`.

## Cleanup antes de testar

Sempre limpe dados de testes anteriores antes de iniciar — evita que itens
acumulados distorçam os resultados (especialmente o `GET /app`):

```bash
# Via psql (mais rápido)
kubectl exec -n comprasweb-local comprasweb-postgresql-0 -- \
  psql -U compras -d lista_compras -c "
    DELETE FROM items
    WHERE tenant_id IN (
      SELECT t.id FROM tenants t
      JOIN tenant_members tm ON tm.tenant_id = t.id
      JOIN users u ON u.id = tm.user_id
      WHERE u.google_id LIKE 'local:%'
    );"
```

O script já inclui cleanup automático no final (Phase 4): marca todos os itens
criados como checked → arquiva → deleta arquivados. A lista fica limpa para
o próximo teste.

## Execução rápida

```bash
# Teste baseline (10 usuários, 30s)
node .claude/skills/qa-load-test/scripts/load-test.js \
  http://localhost:3000 10 30

# Teste de estresse (50 usuários, 60s)
node .claude/skills/qa-load-test/scripts/load-test.js \
  http://localhost:3000 50 60

# Variáveis de ambiente para credenciais não-default
LOCAL_AUTH_USER=loadtest LOCAL_AUTH_PASSWORD=loadtest123 \
  node .claude/skills/qa-load-test/scripts/load-test.js \
  http://localhost:3000 100 120
```

## Monitoramento paralelo (terminal separado)

```bash
# Logs em tempo real
kubectl logs -f -n comprasweb-local -l app=comprasweb

# CPU e memória a cada 5s
watch -n5 kubectl top pod -n comprasweb-local

# Erros específicos
kubectl logs -n comprasweb-local -l app=comprasweb \
  | grep -E "error|Error|500|FATAL" | tail -50
```

Se `kubectl top` não funcionar, instale o metrics-server:
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

## Protocolo de teste em fases

Execute sempre nesta ordem para identificar o ponto de quebra com precisão:

| Fase | Usuários | Duração | Objetivo |
|------|----------|---------|----------|
| Baseline | 5 | 30s | Referência sem pressão |
| Ramp-up | 20 | 60s | Comportamento sob carga moderada |
| Estresse | 50 | 60s | Início da degradação |
| Pico | 100 | 60s | Ponto de quebra |
| Recuperação | 10 | 30s | Verifica se o app se recupera |

## Interpretando os resultados

### Onde está o gargalo?

| Sintoma | Elo fraco provável |
|---------|-------------------|
| P99 de `list` explode (>2s) | Banco de dados — query lenta ou falta de índice |
| P99 de `add`/`check` explode mas `list` OK | RLS transaction overhead ou locks |
| Todos os P99 explodem juntos | Node.js — event loop bloqueado ou OOM |
| Erros 502/504 esporádicos | Socket.IO — redis adapter saturado |
| CPU do pod > 80% constante | App precisa de mais CPU limit / HPA |
| Memory crescendo sem parar | Memory leak — restart periódico ou limit baixo |

### Fórmula para resources do Helm

Após os testes, use as métricas coletadas:

```
CPU request  = uso médio em carga moderada × 1.2
CPU limit    = uso de pico × 1.5  (nunca menos que 200m)
Memory req   = uso médio × 1.2
Memory limit = uso de pico × 1.3  (nunca menos que 256Mi)

HPA minReplicas = 1
HPA maxReplicas = ceil(usuários_alvo / usuários_por_pod)
HPA targetCPU   = 60%  (aciona scale antes de saturar)
```

### Aplicar no Helm

```yaml
# comprasweb/values-prod.yaml
comprasweb:
  resources:
    requests:
      cpu: "XXXm"
      memory: "XXXMi"
    limits:
      cpu: "XXXm"
      memory: "XXXMi"

hpa:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 60
```

## Relatório gerado

O script salva `qa-report-{timestamp}.json` com:
- Métricas por operação (count, errors, P50/P95/P99, min/max)
- Resumo de gargalos detectados
- Recomendações de resources
- Input para o próximo release comparar com o anterior

Para comparar releases:
```bash
node -e "
  const prev = require('./qa-report-ANTERIOR.json');
  const curr = require('./qa-report-ATUAL.json');
  Object.keys(curr.operations).forEach(op => {
    const p = prev.operations[op]?.p95 || 'N/A';
    const c = curr.operations[op]?.p95 || 'N/A';
    console.log(op + ': ' + p + ' → ' + c);
  });
"
```

## Referência rápida de operações testadas

| Operação | Endpoint | O que mede |
|----------|----------|------------|
| `auth` | POST /access | Throughput de autenticação |
| `add` | POST /app/add | Escrita no banco c/ RLS |
| `check` | POST /app/check | Update simples c/ Socket.IO |
| `critical` | PATCH /app/item/:id | Update + emit event |
| `quantity` | PATCH /app/item/:id | Update com debounce |
| `list` | GET /app | Leitura pesada (join 3 tabelas) |
| `clear` | POST /app/clear-checked | Bulk update + event |
