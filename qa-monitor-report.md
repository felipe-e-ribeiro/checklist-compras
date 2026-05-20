# Load Test Monitoring Report — checklist-compras (comprasweb-local)

**Date:** 2026-05-20
**Namespace:** comprasweb-local
**Monitoring window:** ~90 seconds

---

## 1. Pod Inventory

| Pod | Ready | Status | Restarts | Age at T=0 |
|---|---|---|---|---|
| comprasweb-local-648d64886d-hc9fk | 1/1 | Running | 0 | 14m |
| comprasweb-postgresql-0 | 1/1 | Running | 0 | 13h |
| comprasweb-redis-848cff9d7b-fthx5 | 1/1 | Running | 0 | 13h |

---

## 2. CPU / Memory Readings

`kubectl top pod` was attempted **before** the test and **after** the test (~T+90s).

**Result (both attempts):** `error: Metrics API not available`

The `metrics-server` is **not installed** in this kind cluster. No CPU or memory figures are available.

**Recommendation:** Install metrics-server to enable resource monitoring:
```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
# For kind clusters (self-signed certs), patch the deployment:
kubectl patch deployment metrics-server -n kube-system \
  --type='json' \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
```

---

## 3. Log Timeline

All log snapshots used `--tail=30` or `--tail=50` against `app=comprasweb`.

| Timestamp | Check Point | Log Output |
|---|---|---|
| T+0s (baseline) | Pre-test | `Server running on http://0.0.0.0:3000` |
| T+10s | Mid-test (early) | `Server running on http://0.0.0.0:3000` |
| T+30s | Mid-test | `Server running on http://0.0.0.0:3000` |
| T+60s | Mid-test (late) | `Server running on http://0.0.0.0:3000` |
| T+90s | Final | `Server running on http://0.0.0.0:3000` |

**Observation:** The only log line emitted throughout the entire monitoring window was the server startup message. No request logs, no error lines, and no warnings were recorded.

---

## 4. Error Analysis

| Error Type | Count | Details |
|---|---|---|
| Application errors | 0 | None found |
| Connection errors | 0 | None found |
| Timeout messages | 0 | None found |
| OOM kills | 0 | None detected |
| CrashLoopBackOff events | 0 | No restarts |
| HTTP 5xx responses | N/A | Not captured (no access log visible) |

---

## 5. Pod Restart Summary

| Pod | Restarts at T=0 | Restarts at T+60s | Restarts at T+90s |
|---|---|---|---|
| comprasweb-local-648d64886d-hc9fk | 0 | 0 | 0 |
| comprasweb-postgresql-0 | 0 | 0 | 0 |
| comprasweb-redis-848cff9d7b-fthx5 | 0 | 0 | 0 |

**No restarts occurred during the load test.**

---

## 6. Unusual Patterns

- **No HTTP access logs visible:** The application (`server.js`) does not appear to be logging individual HTTP requests to stdout. During a load test this means there is no observability into request throughput, latency, or error rates from `kubectl logs` alone. Consider adding a request logging middleware (e.g. `morgan`) if it is not already enabled, or confirm logs are being suppressed by a log level setting.
- **metrics-server absent:** Resource pressure (CPU throttling, memory approaching limits) cannot be observed without it. An OOM kill would only be detectable via pod restarts, not via metrics.
- **Single replica for app pod:** Only one `comprasweb-local` replica was running. A crash under load would cause a brief outage with no automatic failover until Kubernetes reschedules.

---

## 7. Overall Assessment

The cluster remained **healthy and stable** throughout the ~90-second monitoring window:

- All three pods stayed in `Running` state with **0 restarts**.
- No errors, panics, or warnings appeared in the application logs.
- The absence of request-level logs prevents confirming that traffic was actually processed; this should be verified by cross-referencing the load test client output (e.g. k6, hey, or wrk results).
- CPU/memory headroom is **unknown** due to missing metrics-server.

**Next steps:**
1. Install metrics-server (see Section 2) and rerun the load test to capture resource usage.
2. Enable HTTP request logging in `server.js` (morgan or similar) so kubectl logs shows per-request data during tests.
3. Cross-check the load test tool's summary (RPS, error rate, p99 latency) to confirm the app was actually serving traffic under load.
