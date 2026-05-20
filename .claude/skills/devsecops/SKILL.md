---
name: devsecops
description: >
  Checklist e guia obrigatório de segurança para o projeto checklist-compras.
  Use esta skill sempre que for fazer um push, abrir um PR, preparar um release,
  mudar o Dockerfile, alterar o Helm chart, adicionar uma dependência, criar ou
  alterar secrets, configurar um novo ambiente, ou sempre que o usuário mencionar
  segurança, CVE, secrets, least privilege, NetworkPolicy, PSS, ARM, non-root,
  read-only filesystem, ou produção. A skill garante que nenhum deploy viole os
  sete requisitos de segurança deste projeto.
---

# DevSecOps — checklist-compras

Sete requisitos de segurança não-negociáveis. Verifique todos antes de qualquer push.

## Checklist pré-push

```
[ ] 1. Nenhum secret no repositório
[ ] 2. Versões pinadas — sem "latest" em produção
[ ] 3. Imagens compatíveis com ARM (linux/arm64 + linux/amd64)
[ ] 4. NetworkPolicies aplicadas (least privilege)
[ ] 5. Container roda como usuário não-root
[ ] 6. Pod Security Standards: baseline enforce, restricted warn
[ ] 7. Filesystem do container da aplicação é read-only
```

Comando de verificação rápida:
```bash
# Verificar secrets expostos
git diff --staged | grep -iE "(password|secret|token|key)\s*[:=]\s*['\"][^'\"]{8,}" || echo "OK"

# Verificar latest em imagens
grep -r "latest" comprasweb/templates/ comprasweb/values*.yaml Dockerfile && echo "PROBLEMA" || echo "OK"

# Verificar securityContext nos pods
kubectl get pods -n comprasweb-local -o json | \
  jq '.items[].spec.containers[].securityContext.runAsNonRoot'
```

---

## 1. Secrets — nunca no repositório

**Regra:** `values-kind.yaml` e `values-prod.yaml` contêm apenas PLACEHOLDERS. Secrets reais são passados via `--set` ou gerenciados externamente.

**O que pode estar no git:**
- Placeholders: `"YOUR_GOOGLE_CLIENT_ID"`, `"CHANGE_IN_PROD"`
- Valores de desenvolvimento claramente identificados: `"local-dev-only"`

**O que nunca pode estar no git:**
- Client secrets OAuth reais
- JWT secrets de produção
- Passwords de banco de produção

**Para fazer deploy com secrets:**
```bash
helm upgrade comprasweb ./comprasweb -f comprasweb/values-prod.yaml \
  --set "comprasweb.googleClientSecret=$SECRET_FROM_VAULT" \
  --set "comprasweb.jwtSecret=$JWT_SECRET_FROM_VAULT" \
  --set "postgresql.auth.password=$DB_PASSWORD_FROM_VAULT"
```

**Gerenciamento externo (produção):**
- Criar o Secret manualmente: `kubectl create secret generic compras-app-secret-prod --from-literal=...`
- Ou usar External Secrets Operator com AWS Secrets Manager / HashiCorp Vault / GCP Secret Manager
- Referenciar no helm via `comprasweb.externalSecretName`

**Verificar:**
```bash
git log --all --full-history -- "*.yaml" | head -5  # histórico de values files
trufflehog filesystem . --only-verified              # se tiver trufflehog instalado
```

---

## 2. Versões pinadas

**Regra:** nenhuma imagem usa `latest` ou tags flutuantes em produção.

| Componente | Tag aceitável | Tag proibida |
|---|---|---|
| App | `sha256:abc123` ou `v2.1.3` | `latest`, `main` |
| PostgreSQL | `16-bookworm` ou `16.9-bookworm` | `latest`, `16`, `postgres` |
| Redis | `7-bookworm` ou `7.4.4-bookworm` | `latest`, `7`, `redis` |
| Node.js base | `22-bookworm-slim` | `lts`, `latest`, `current` |

**Para produção:** a tag deve ser o SHA do git commit gerado pelo CI/CD:
```yaml
comprasweb:
  image:
    tag: "abc123def456"  # sha curto do commit
```

**O CI/CD já faz isso:** `.github/workflows/ci.yaml` publica com o tag do release.

**kind/dev:** `comprasweb-local:latest` é aceitável — é uma imagem local que não vai para registro.

---

## 3. Compatibilidade ARM

**Regra:** todas as imagens de produção devem suportar `linux/arm64`.

**Verificar:**
```bash
# Verificar manifesto multi-arch
docker manifest inspect postgres:16-bookworm | jq '.manifests[].platform'

# Build multi-arch local
docker buildx build --platform linux/amd64,linux/arm64 -t comprasweb:test .
```

**Base images aprovadas (multi-arch):**
- `node:22-bookworm-slim` — suporta amd64 + arm64
- `postgres:16-bookworm` — suporta amd64 + arm64
- `redis:7-bookworm` — suporta amd64 + arm64
- `busybox:1.36` — suporta amd64 + arm64

**CI/CD:** o workflow já usa `platforms: linux/amd64,linux/arm64`. Nunca remover esse campo.

---

## 4. NetworkPolicies (least privilege)

**Regra:** o namespace tem um `default-deny-all`. Cada pod tem políticas explícitas.

**Topologia permitida:**
```
internet → [ingress-nginx] → [app:3000] → [postgres:5432]
                                       → [redis:6379]
                                       → [kube-dns:53]
```

Nada mais é permitido. O app não pode acessar a internet. O postgres e redis não podem iniciar conexões.

**Verificar:**
```bash
kubectl get networkpolicy -n comprasweb-local
kubectl describe networkpolicy default-deny-all -n comprasweb-local
```

**Se um pod não consegue conectar após mudanças:**
1. Verificar labels do pod: `kubectl get pod <pod> -n comprasweb-local --show-labels`
2. Labels devem bater com os seletores das NetworkPolicies
3. Verificar se a policy de DNS está presente (porta 53 UDP/TCP para kube-dns)

---

## 5. Container não-root

**Regra:** nenhum container roda como UID 0 (root).

| Container | UID | Usuário |
|---|---|---|
| App (Node.js) | 1000 | `node` (built-in da imagem) |
| PostgreSQL | 999 | `postgres` (built-in) |
| Redis | 999 | `redis` (built-in) |
| Migration job | 1000 | `node` |

**Verificar:**
```bash
kubectl get pods -n comprasweb-local -o jsonpath=\
  '{range .items[*]}{.metadata.name}: {.spec.securityContext.runAsUser}{"\n"}{end}'

# Dentro do container
kubectl exec -n comprasweb-local <pod> -- id
```

**Se falhar:** verificar se `securityContext.runAsNonRoot: true` e `runAsUser` estão no deployment.yaml. Verificar se o Dockerfile tem `USER node` antes do CMD.

---

## 6. Pod Security Standards

**Regra:** namespace com `enforce: baseline` e `warn: restricted`.

Labels obrigatórios no namespace:
```bash
kubectl label namespace comprasweb-local \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/warn-version=latest \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/audit-version=latest
```

**Restricted exige (por container):**
- `allowPrivilegeEscalation: false`
- `capabilities.drop: ["ALL"]`
- `runAsNonRoot: true`
- `seccompProfile.type: RuntimeDefault`

**Verificar compliance:**
```bash
kubectl auth can-i --list --as=system:serviceaccount:comprasweb-local:comprasweb-local-account -n comprasweb-local
kubectl get events -n comprasweb-local | grep -i "warning\|forbidden\|pss"
```

---

## 7. Filesystem read-only

**Regra:** o container da aplicação (Node.js) tem `readOnlyRootFilesystem: true`.

**Volumes necessários para a aplicação funcionar com RO:**
- `/tmp` → emptyDir (tmpfs)

PostgreSQL e Redis usam volumes específicos para dados e sockets — não são read-only.

**Verificar:**
```bash
kubectl get pod -n comprasweb-local -l app=comprasweb -o json | \
  jq '.items[0].spec.containers[0].securityContext.readOnlyRootFilesystem'
# deve retornar: true

# Tentar escrever dentro do container (deve falhar)
kubectl exec -n comprasweb-local <app-pod> -- touch /test.txt 2>&1
# deve retornar: Read-only file system
```

---

## Referência: arquivos relevantes

| Arquivo | O que controla |
|---|---|
| `Dockerfile` | Base image, USER, versão Node.js |
| `comprasweb/templates/deployment.yaml` | securityContext do app |
| `comprasweb/templates/migration-job.yaml` | securityContext do migration |
| `comprasweb/templates/postgresql.yaml` | versão PG, securityContext |
| `comprasweb/templates/redis.yaml` | versão Redis, securityContext |
| `comprasweb/templates/networkpolicy.yaml` | todas as NetworkPolicies |
| `scripts/kind-setup.sh` | PSS labels no namespace |
| `comprasweb/values-kind.yaml` | apenas placeholders de dev |

Spec completo: `docs/superpowers/specs/` — procurar por spec de segurança.
