---
name: kind-ops
description: >
  Guia obrigatório para operar o cluster kind local do projeto checklist-compras.
  Use esta skill sempre que precisar: criar ou recriar o cluster kind, fazer
  deploy ou redeploy da aplicação, monitorar logs e status codes HTTP (incluindo
  5xx), checar uso de CPU/memória com kubectl top, fazer port-forward, carregar
  imagens no kind, diagnosticar crashLoopBackOff ou ImagePullBackOff, preparar
  o ambiente para testes de carga, ou entender qualquer aspecto do setup local
  de Kubernetes. Inclui o metrics-server obrigatório para observabilidade.
---

# kind-ops — checklist-compras

Operação do cluster kind local. Todo o setup está automatizado em
`scripts/kind-setup.sh`. Esta skill cobre operações do dia-a-dia.

## Setup inicial (do zero)

```bash
# Setup completo automatizado — inclui cluster, ingress, metrics-server,
# build de imagem, helm deploy e port-forward
bash scripts/kind-setup.sh
```

O script pede as credenciais do Google OAuth interativamente.  
Após concluir: `http://localhost:3000` está acessível.

## Redeploy (nova versão do código)

```bash
docker build -t comprasweb-local:latest .
kind load docker-image comprasweb-local:latest --name compras
kubectl rollout restart deployment/comprasweb-local -n comprasweb-local
kubectl rollout status deployment/comprasweb-local -n comprasweb-local --timeout=60s
```

## Port-forward

O port-forward cai com frequência — sempre que `http://localhost:3000` não responder:

```bash
# Matar port-forward antigo e reabrir
pkill -f "port-forward.*3000" 2>/dev/null; sleep 1
kubectl port-forward -n comprasweb-local svc/comprasweb 3000:3000 &
sleep 3 && curl -s http://localhost:3000/healthz
```

## Monitorar logs HTTP (morgan está ativo)

O app usa morgan no formato `:method :url :status :response-time ms`.
Cada request aparece nos logs do pod.

```bash
# Stream de todos os requests
kubectl logs -f -n comprasweb-local -l app=comprasweb

# Filtrar erros 5xx
kubectl logs -n comprasweb-local -l app=comprasweb | grep ' [5][0-9][0-9] '

# Filtrar erros 4xx
kubectl logs -n comprasweb-local -l app=comprasweb | grep ' [4][0-9][0-9] '

# Durante load test — stream só de erros
kubectl logs -f -n comprasweb-local -l app=comprasweb | grep -E ' [45][0-9][0-9] '
```

## Monitorar recursos (metrics-server obrigatório)

O metrics-server é instalado pelo `kind-setup.sh`. Verificar se está ativo:

```bash
kubectl top pod -n comprasweb-local
# Se retornar "Metrics API not available", instalar:
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl patch deployment metrics-server -n kube-system \
  --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl rollout status deployment/metrics-server -n kube-system --timeout=90s
```

Monitoramento contínuo durante testes:
```bash
watch -n3 kubectl top pod -n comprasweb-local
```

## Diagnóstico de problemas comuns

### Pod em CrashLoopBackOff

```bash
# Logs do crash anterior
kubectl logs -n comprasweb-local -l app=comprasweb --previous

# Causas mais comuns neste projeto:
# 1. Migração não aplicada: coluna faltando no banco
#    → helm upgrade para disparar o migration job
# 2. Imagem Alpine (musl vs glibc): bcrypt não funciona
#    → Dockerfile usa node:lts (Debian), não Alpine
# 3. Env vars faltando: JWT_SECRET, GOOGLE_CLIENT_ID
#    → helm upgrade --set comprasweb.xxx=yyy ...
```

### ImagePullBackOff

```bash
# Sempre usar imagePullPolicy: Never com imagem local no kind
# E carregar a imagem com kind load antes do helm upgrade
kind load docker-image comprasweb-local:latest --name compras
```

### Migração falhando (migration job)

```bash
# Ver logs do job de migração
kubectl logs -n comprasweb-local -l app=comprasweb-migrate

# Forçar reexecução via helm upgrade
helm upgrade comprasweb ./comprasweb -f comprasweb/values-kind.yaml \
  -n comprasweb-local [--set credenciais...]

# Verificar schema atual
kubectl exec -n comprasweb-local comprasweb-postgresql-0 -- \
  psql -U compras -d lista_compras -c "\dt"
```

### Banco de dados — verificar dados e schema

```bash
# Listar tabelas
kubectl exec -n comprasweb-local comprasweb-postgresql-0 -- \
  psql -U compras -d lista_compras -c "\dt"

# Descrever tabela items
kubectl exec -n comprasweb-local comprasweb-postgresql-0 -- \
  psql -U compras -d lista_compras -c "\d items"

# Contar rows por tabela
kubectl exec -n comprasweb-local comprasweb-postgresql-0 -- \
  psql -U compras -d lista_compras -c \
  "SELECT 'tenants', count(*) FROM tenants UNION ALL
   SELECT 'users', count(*) FROM users UNION ALL
   SELECT 'items', count(*) FROM items;"
```

## Helm — operações frequentes

```bash
# Ver release atual
helm list -n comprasweb-local

# Upgrade com credenciais Google (template)
helm upgrade comprasweb ./comprasweb -f comprasweb/values-kind.yaml \
  -n comprasweb-local --timeout 8m \
  --set "comprasweb.googleClientId=GOOGLE_CLIENT_ID" \
  --set "comprasweb.googleClientSecret=GOOGLE_CLIENT_SECRET" \
  --set "comprasweb.googleCallbackUrl=http://localhost:3000/auth/google/callback" \
  --set "comprasweb.appUrl=http://localhost:3000"

# Ver status do deployment
kubectl rollout status deployment/comprasweb-local -n comprasweb-local

# Checar pods, services e ingress
kubectl get pods,svc,ingress -n comprasweb-local
```

## Preparar ambiente para load test (QA)

Antes de rodar o `qa-load-test`:

```bash
# 1. Confirmar cluster ativo
kind get clusters  # deve mostrar "compras"

# 2. Confirmar pods saudáveis
kubectl get pods -n comprasweb-local
# app: 1/1 Running | postgresql: 1/1 Running | redis: 1/1 Running

# 3. Confirmar metrics-server
kubectl top pod -n comprasweb-local  # deve mostrar CPU e memória

# 4. Port-forward ativo
curl -sf http://localhost:3000/healthz && echo OK

# 5. Auth local disponível
curl -sf http://localhost:3000/access | grep -c "Acesso"  # deve ser 1

# 6. Stream de logs em terminal separado
kubectl logs -f -n comprasweb-local -l app=comprasweb | grep -E ' [45][0-9][0-9] '
```

## Destruir e recriar cluster

```bash
# Destruir tudo
kind delete cluster --name compras

# Recriar do zero
bash scripts/kind-setup.sh
```
