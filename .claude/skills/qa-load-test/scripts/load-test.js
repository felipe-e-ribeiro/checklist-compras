#!/usr/bin/env node
/**
 * checklist-compras Load Test Script
 * Uso: node load-test.js [url] [users] [duration_seconds]
 * Env: LOCAL_AUTH_USER, LOCAL_AUTH_PASSWORD
 *
 * Sem dependências externas — apenas Node.js built-ins.
 */

const http  = require('http');
const https = require('https');
const { URL } = require('url');
const fs    = require('fs');

const BASE_URL  = process.argv[2] || 'http://localhost:3000';
const MAX_USERS = parseInt(process.argv[3] || '10');
const DURATION  = parseInt(process.argv[4] || '30');
const AUTH_USER = process.env.LOCAL_AUTH_USER     || 'loadtest';
const AUTH_PASS = process.env.LOCAL_AUTH_PASSWORD || 'loadtest123';

// ── Metrics store ──────────────────────────────────────────────────────
const m = { times: {}, errors: {}, start: Date.now() };

function rec(op, ms, ok) {
  (m.times[op] = m.times[op] || []).push(ms);
  if (!ok) m.errors[op] = (m.errors[op] || 0) + 1;
}

// ── HTTP helper ────────────────────────────────────────────────────────
function request(method, path, body, cookies) {
  return new Promise((resolve, reject) => {
    const u   = new URL(path, BASE_URL);
    const lib = u.protocol === 'https:' ? https : http;
    const isJson = body && typeof body === 'object';
    const bodyStr = body ? (isJson ? JSON.stringify(body) : body) : null;
    const ct = bodyStr
      ? (isJson ? 'application/json' : 'application/x-www-form-urlencoded')
      : null;

    const opts = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method,
      headers: {
        Accept: 'application/json',
        ...(cookies ? { Cookie: cookies } : {}),
        ...(ct ? { 'Content-Type': ct } : {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const t0 = Date.now();
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: data, ms: Date.now() - t0 })
      );
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function cookies(headers) {
  return (headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

// ── Operations ─────────────────────────────────────────────────────────
async function auth() {
  const body = `username=${encodeURIComponent(AUTH_USER)}&password=${encodeURIComponent(AUTH_PASS)}`;
  const res  = await request('POST', '/access', body, null);
  if (res.status !== 302 && res.status !== 200) throw new Error(`auth ${res.status}`);
  return cookies(res.headers);
}

async function addItem(jar) {
  const name = 'Item-' + Math.random().toString(36).slice(2, 7);
  const res  = await request('POST', '/app/add', `item=${encodeURIComponent(name)}`, jar);
  rec('add', res.ms, res.status < 400);
  try { return JSON.parse(res.body).id; } catch { return null; }
}

async function checkItem(jar, id) {
  const res = await request('POST', '/app/check', `id=${id}&checked=on`, jar);
  rec('check', res.ms, res.status < 400);
}

async function toggleCritical(jar, id) {
  const res = await request('PATCH', `/app/item/${id}`, { is_critical: true }, jar);
  rec('critical', res.ms, res.status < 400);
}

async function updateQty(jar, id) {
  const res = await request('PATCH', `/app/item/${id}`, { quantity: '500g' }, jar);
  rec('quantity', res.ms, res.status < 400);
}

async function listItems(jar) {
  const res = await request('GET', '/app', null, jar);
  rec('list', res.ms, res.status < 400);
}

async function clearChecked(jar) {
  const res = await request('POST', '/app/clear-checked', '', jar);
  rec('clear', res.ms, res.status < 400);
}

// ── User session ───────────────────────────────────────────────────────
async function session(jar, sharedIds) {
  const id = await addItem(jar);
  if (id) sharedIds.push(id);

  if (sharedIds.length > 0) {
    const pick = sharedIds[Math.floor(Math.random() * sharedIds.length)];
    await Promise.all([
      checkItem(jar, pick),
      toggleCritical(jar, pick),
      updateQty(jar, pick),
    ]);
  }

  await listItems(jar);
}

// ── Stats ──────────────────────────────────────────────────────────────
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

function stats(op) {
  const t = m.times[op] || [];
  const e = m.errors[op] || 0;
  if (!t.length) return null;
  const avg = Math.round(t.reduce((s, v) => s + v, 0) / t.length);
  return {
    count:     t.length,
    errors:    e,
    errorPct:  +((e / t.length) * 100).toFixed(1),
    avg:       avg,
    p50:       pct(t, 50),
    p95:       pct(t, 95),
    p99:       pct(t, 99),
    min:       Math.min(...t),
    max:       Math.max(...t),
  };
}

function pad(s, n) { return String(s).padStart(n); }
function ms(v) { return v + 'ms'; }

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log(`║  checklist-compras Load Test                         ║`);
  console.log(`║  URL: ${BASE_URL.padEnd(45)}║`);
  console.log(`║  Users: ${String(MAX_USERS).padEnd(5)}  Duration: ${String(DURATION).padEnd(3)}s                  ║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── Phase 1: Auth ────────────────────────────────────────────────────
  process.stdout.write('▶ Phase 1: Auth warmup... ');
  let jar;
  const t0 = Date.now();
  try {
    jar = await auth();
    const d = Date.now() - t0;
    rec('auth', d, true);
    console.log(`✓ (${d}ms)\n`);
  } catch (e) {
    console.error(`✗ ${e.message}\n  Check: LOCAL_AUTH_ENABLED=true and port-forward active`);
    process.exit(1);
  }

  const sharedIds = [];

  // ── Phase 2: Ramp-up ─────────────────────────────────────────────────
  console.log(`▶ Phase 2: Ramp-up (1 → ${MAX_USERS} users)`);
  const steps = [...new Set([1, Math.ceil(MAX_USERS * 0.25), Math.ceil(MAX_USERS * 0.5), MAX_USERS])];
  for (const n of steps) {
    const t = Date.now();
    await Promise.all(Array.from({ length: n }, () => session(jar, sharedIds)));
    console.log(`  ${String(n).padStart(4)} users → ${Date.now() - t}ms`);
    await new Promise(r => setTimeout(r, 200));
  }

  // ── Phase 3: Sustained load ──────────────────────────────────────────
  console.log(`\n▶ Phase 3: Sustained load (${MAX_USERS} users × ${DURATION}s)`);
  const end = Date.now() + DURATION * 1000;
  let waves = 0, errors = 0;
  while (Date.now() < end) {
    const results = await Promise.allSettled(
      Array.from({ length: MAX_USERS }, () => session(jar, sharedIds))
    );
    errors += results.filter(r => r.status === 'rejected').length;
    waves++;
    if (waves % 10 === 0) {
      const elapsed = Math.round((Date.now() - m.start) / 1000);
      const total = Object.values(m.times).reduce((s, a) => s + a.length, 0);
      process.stdout.write(`  Wave ${waves} | ${elapsed}s | ${total} reqs | ${errors} failures  \r`);
    }
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\n  Done: ${waves} waves\n`);

  // ── Phase 4: Clear + cooldown ─────────────────────────────────────────
  process.stdout.write('▶ Phase 4: Clear + cooldown... ');
  await clearChecked(jar);
  console.log('✓\n');

  // ── Report ────────────────────────────────────────────────────────────
  const ops = ['auth', 'add', 'list', 'check', 'critical', 'quantity', 'clear'];
  const elapsed = Math.round((Date.now() - m.start) / 1000);
  const allTimes = ops.flatMap(op => m.times[op] || []);
  const totalReqs = allTimes.length;
  const totalErr  = ops.reduce((s, op) => s + (m.errors[op] || 0), 0);

  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                          LOAD TEST REPORT                                   ║');
  console.log(`║  Duration: ${String(elapsed).padEnd(4)}s   Peak: ${String(MAX_USERS).padEnd(4)} users   Total reqs: ${String(totalReqs).padEnd(7)} Errors: ${totalErr}   ║`);
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.log('║ Operation  │  Count  │ Err%  │  Avg   │  P50   │  P95   │  P99   │  Max    ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');

  const opStats = {};
  for (const op of ops) {
    const s = stats(op);
    if (!s) continue;
    opStats[op] = s;
    const warn = s.p99 > 1000 ? '⚠' : s.p95 > 500 ? '~' : '✓';
    console.log(
      `║ ${warn} ${op.padEnd(9)}│${pad(s.count,8)} │${pad(s.errorPct,5)}% │` +
      `${pad(ms(s.avg),7)} │${pad(ms(s.p50),7)} │${pad(ms(s.p95),7)} │${pad(ms(s.p99),7)} │${pad(ms(s.max),7)}  ║`
    );
  }

  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.log(`║ Overall P95: ${ms(pct(allTimes,95)).padEnd(8)} P99: ${ms(pct(allTimes,99)).padEnd(8)} Error rate: ${((totalErr/totalReqs)*100).toFixed(1).padEnd(5)}%                    ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝\n');

  // ── Bottleneck analysis ───────────────────────────────────────────────
  console.log('BOTTLENECK ANALYSIS:');
  const slowest = ops.reduce((s, op) => {
    const avg = (opStats[op] || {}).avg || 0;
    return avg > s.avg ? { op, avg } : s;
  }, { op: 'none', avg: 0 });

  const p99Overall = pct(allTimes, 99);
  let bottleneck = 'Not determined';
  let advice = '';

  if ((opStats.list?.p99 || 0) > 2000) {
    bottleneck = 'DATABASE — query lenta (GET /app faz join de 3 tabelas)';
    advice = 'Verifique EXPLAIN ANALYZE em tenant_members JOIN tenants. Cheque índices compostos.';
  } else if ((opStats.add?.p99 || 0) > 1000 && (opStats.list?.p99 || 0) < 500) {
    bottleneck = 'DATABASE — RLS transaction overhead em INSERT/UPDATE';
    advice = 'Considere reduzir round-trips por request. Verifique pg_stat_activity durante carga.';
  } else if (p99Overall > 2000 && totalErr / totalReqs > 0.05) {
    bottleneck = 'APPLICATION — Node.js event loop saturado ou OOM';
    advice = 'Aumente CPU limit. Habilite cluster mode. Verifique memory leak com heap profiler.';
  } else if (totalErr / totalReqs > 0.01) {
    bottleneck = 'REDIS — Socket.IO adapter ou conexões esgotadas';
    advice = 'Verifique redis maxmemory e conexões ativas. Considere redis cluster.';
  } else {
    bottleneck = 'Sem gargalo crítico detectado nesta carga';
    advice = 'Aumente MAX_USERS para encontrar o ponto de saturação.';
  }

  console.log(`  Slowest op:  ${slowest.op} (avg ${slowest.avg}ms)`);
  console.log(`  P99 global:  ${p99Overall}ms`);
  console.log(`  Error rate:  ${((totalErr/totalReqs)*100).toFixed(2)}%`);
  console.log(`  Bottleneck:  ${bottleneck}`);
  console.log(`  Action:      ${advice}`);

  // ── Resource recommendation ───────────────────────────────────────────
  console.log('\nRESOURCE RECOMMENDATIONS (based on this test):');
  console.log('  Run `kubectl top pod -n comprasweb-local` values collected during test:');
  console.log('  If CPU peak was X millicores:');
  console.log(`    requests.cpu:    ceil(X * 1.2)m`);
  console.log(`    limits.cpu:      ceil(X * 1.5)m  (min 200m)`);
  console.log(`    hpa.targetCPU:   60%`);
  console.log(`    hpa.maxReplicas: ceil(${MAX_USERS} / users_per_pod)`);

  // ── Save JSON report ──────────────────────────────────────────────────
  const reportsDir = require('path').join(__dirname, '../../../../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const reportFile = require('path').join(reportsDir, `qa-report-${dateStr}-${Date.now()}.json`);
  const report = {
    timestamp:   new Date().toISOString(),
    config:      { url: BASE_URL, maxUsers: MAX_USERS, durationS: DURATION },
    environment: { node: process.version, platform: process.platform },
    operations:  opStats,
    summary: {
      totalRequests: totalReqs,
      totalErrors:   totalErr,
      errorRate:     +((totalErr / totalReqs) * 100).toFixed(2),
      durationS:     elapsed,
      p95Overall:    pct(allTimes, 95),
      p99Overall:    p99Overall,
      slowestOp:     slowest.op,
      bottleneck,
    },
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\n  ✓ Report: ${reportFile}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
