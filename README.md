# Lista de Compras

Multi-tenant shopping list web application. Share lists in real-time with family or any group. Each workspace is isolated — members only see what they belong to.

## Features

- **Google OAuth** authentication
- **Real-time sync** via Socket.IO (items appear instantly on all connected devices)
- **Multi-tenant workspaces** — create or join lists, invite members via time-limited links
- **Item management** — add, check, mark as critical (priority), set quantity
- **GDPR compliant** — cookie consent, data export, account anonymization
- **Kubernetes-native** — Helm chart with NetworkPolicies, non-root containers, read-only filesystem, cert-manager TLS

## Tech Stack

Node.js · Express · PostgreSQL (RLS) · Redis · Socket.IO · EJS · Helm · GitHub Actions

---

## Production Deploy (Helm)

### Prerequisites

- Kubernetes cluster (1.24+)
- [Helm 3](https://helm.sh/docs/intro/install/)
- `nginx` ingress controller installed
- [cert-manager](https://cert-manager.io/docs/installation/) installed with a `ClusterIssuer` configured

### 1. Create the namespace

```bash
kubectl create namespace comprasweb-prod
```

### 2. Gather required credentials

All secrets are passed at deploy time — never stored in values files.

```bash
export JWT_SECRET="$(openssl rand -hex 32)"   # strong random secret
export DB_PASSWORD="<postgres-password>"
export GOOGLE_CLIENT_ID="<oauth-client-id>"
export GOOGLE_CLIENT_SECRET="<oauth-client-secret>"
```

**Getting Google OAuth credentials:**
1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project → Enable Google OAuth 2.0
3. Create an OAuth 2.0 Client ID (Web application type)
4. Add `https://your-domain.com/auth/google/callback` to **Authorized redirect URIs**
5. Note the Client ID and Client Secret

### 3. Deploy

```bash
helm upgrade --install comprasweb ./comprasweb \
  -f comprasweb/values-prod.yaml \
  -n comprasweb-prod \
  --set comprasweb.image.tag="v2.x.x" \
  --set comprasweb.jwtSecret="$JWT_SECRET" \
  --set comprasweb.googleClientId="$GOOGLE_CLIENT_ID" \
  --set comprasweb.googleClientSecret="$GOOGLE_CLIENT_SECRET" \
  --set comprasweb.googleCallbackUrl="https://your-domain.com/auth/google/callback" \
  --set comprasweb.appUrl="https://your-domain.com" \
  --set postgresql.auth.password="$DB_PASSWORD" \
  --set ingress.hosts[0].host="your-domain.com" \
  --set ingress.tls.config[0].hosts[0]="your-domain.com"
```

### 4. Verify

```bash
kubectl get pods -n comprasweb-prod
kubectl get certificate -n comprasweb-prod   # TLS cert issued by cert-manager
kubectl logs -n comprasweb-prod -l app=comprasweb -f
```

### Configuration reference

| Field | Description |
|---|---|
| `comprasweb.image.tag` | Docker image tag — set by CI/CD on each release |
| `comprasweb.jwtSecret` | JWT signing secret — minimum 32 random bytes |
| `comprasweb.googleClientId/Secret` | Google OAuth 2.0 credentials |
| `comprasweb.googleCallbackUrl` | Must match exactly the URI registered in Google Cloud |
| `comprasweb.appUrl` | Base URL used to generate invite links |
| `comprasweb.webConcurrency` | Node.js cluster workers (default `4`) |
| `postgresql.auth.password` | PostgreSQL password |
| `ingress.certManager.clusterIssuer` | cert-manager ClusterIssuer name (default: `letsencrypt-prod`) |
| `ingress.certManager.issuer` | Use instead of `clusterIssuer` for namespace-scoped Issuers |
| `hpa.minReplicas / maxReplicas` | Auto-scaling bounds (default 2–8) |

### External managed database (recommended for production)

Set `postgresql.enabled: false` in `values-prod.yaml` and provide connection details via `--set`:

```bash
helm upgrade ... \
  --set postgresql.enabled=false \
  --set comprasweb.dbHost="your-db-host" \
  --set comprasweb.dbUser="compras" \
  --set comprasweb.dbPassword="$DB_PASSWORD" \
  --set comprasweb.dbName="lista_compras"
```

---

## Database Migrations

Migrations run automatically as a Helm hook (`post-install`, `post-upgrade`). No manual action required on deploy.

---

## CI/CD

GitHub Actions (`.github/workflows/ci.yaml`) triggers on every PR and release:

1. **test** — runs all tests with 100% coverage enforcement, using Postgres + Redis as services
2. **trivy** — scans the Docker image; blocks on CRITICAL CVEs
3. **build-and-push** — multi-arch image (`linux/amd64` + `linux/arm64`), published only on release

Image published to Docker Hub: `feliperibeiro95/checklist-compras`

---

## Local Development (kind)

```bash
# Full automated setup: kind cluster + nginx ingress + metrics-server + Helm deploy
bash scripts/kind-setup.sh

# Run tests
cd website && npm run test:local

# App available at http://localhost:3000
```

Requires: `kind`, `kubectl`, `helm`, `docker`.

---

## License

MIT
