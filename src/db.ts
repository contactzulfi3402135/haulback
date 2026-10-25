import { existsSync, readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import type { ClaimCategory } from './rating.js';
import type { Bundle, BundleStat } from './strategy.js';
import { asset } from './assets.js';

export type Agg = { calls: number; in: number; out: number; cost: number; ms: number };

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined,
});

type Q = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };
export async function q(text: string, values: unknown[] = [], client: Q = pool): Promise<any[]> {
  return (await client.query(text, values)).rows;
}

export async function migrate(): Promise<void> {
  if (!existsSync(asset('db/migrations'))) return;
  for (const file of readdirSync(asset('db/migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(asset(`db/migrations/${file}`), 'utf8'));
  }
}

export async function withLock<T>(key: number, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [key]);
    return await fn();
  } finally {
    try {
      await client.query('select pg_advisory_unlock($1)', [key]);
    } finally {
      client.release();
    }
  }
}

export async function tryWithLock<T>(key: number, fn: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const client = await pool.connect();
  try {
    const rows = (await client.query('select pg_try_advisory_lock($1) as ok', [key])).rows;
    if (!rows[0]?.ok) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await client.query('select pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}

export const scopeKey = (key: string, scope: string): string => `${key}:${scope}`;
export async function getState(key: string): Promise<string | null> {
  const rows = await q('select value from haulback.state where key = $1', [key]);
  return rows.length ? String(rows[0].value) : null;
}
export async function setState(key: string, value: string): Promise<void> {
  await q(
    `insert into haulback.state (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value`,
    [key, value],
  );
}

export async function recordSettingsHistory(scope: string, settings: unknown, changedBy: string): Promise<void> {
  await q('insert into haulback.settings_history (scope, settings, changed_by) values ($1,$2::jsonb,$3)', [
    scope,
    JSON.stringify(settings),
    changedBy,
  ]);
}
export async function settingsHistory(scope: string, limit = 10): Promise<any[]> {
  return q('select * from haulback.settings_history where scope=$1 order by changed_at desc limit $2', [scope, limit]);
}

export async function startRun(kind: string, draftModel: string, scope: string, note = ''): Promise<number> {
  const rows = await q('insert into haulback.runs (kind, draft_model, scope, note) values ($1,$2,$3,$4) returning id', [kind, draftModel, scope, note]);
  return Number(rows[0].id);
}
export async function finishRun(runId: number, stats: unknown): Promise<void> {
  await q('update haulback.runs set finished_at = now(), stats = $2::jsonb where id = $1', [runId, JSON.stringify(stats)]);
}
export async function listRuns(scope?: string, limit = 20): Promise<any[]> {
  return scope
    ? q('select *, draft_model as model from haulback.runs where scope=$1 order by started_at desc limit $2', [scope, limit])
    : q('select *, draft_model as model from haulback.runs order by started_at desc limit $1', [limit]);
}

export const agg: Agg = { calls: 0, in: 0, out: 0, cost: 0, ms: 0 };
export function resetAgg(): void {
  agg.calls = 0;
  agg.in = 0;
  agg.out = 0;
  agg.cost = 0;
  agg.ms = 0;
}
export async function recordCall(runId: number | 0, r: {
  stage: string; model: string; ids: string[]; inTok: number; outTok: number; cost: number; ms: number; error: string | null;
}): Promise<void> {
  if (runId) {
    await q(
      'insert into haulback.calls (run_id, stage, model, entity_ids, input_tokens, output_tokens, cost_usd, ms, error) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [runId, r.stage, r.model, r.ids, r.inTok, r.outTok, r.cost, r.ms, r.error],
    );
  }
  agg.calls += 1;
  agg.in += r.inTok;
  agg.out += r.outTok;
  agg.cost += r.cost;
  agg.ms += r.ms;
}

export async function recordDecision(runId: number | 0, d: {
  scope: string; shipmentId: string; chargeId: string; worldDay: number; carrier: string; category: string; bundle: string; action: string; outcome: string; why: string;
}): Promise<void> {
  await q(
    'insert into haulback.decisions (run_id, scope, shipment_id, charge_id, world_day, carrier, category, bundle, action, outcome, why) values (nullif($1,0),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [runId, d.scope, d.shipmentId, d.chargeId, d.worldDay, d.carrier, d.category, d.bundle, d.action, d.outcome, d.why],
  );
}
export async function decisionsFor(scope: string, shipmentId: string): Promise<any[]> {
  return q('select * from haulback.decisions where scope=$1 and shipment_id=$2 order by at desc', [scope, shipmentId]);
}
export async function recentDecisions(scope: string, limit = 100): Promise<any[]> {
  return q('select * from haulback.decisions where scope=$1 order by at desc limit $2', [scope, limit]);
}

export async function enqueue(scope: string, shipmentId: string, chargeId: string, kind: string, why: string, detail: unknown = {}): Promise<void> {
  const rows = await q(
    'select id from haulback.queue where scope=$1 and shipment_id=$2 and charge_id=$3 and kind=$4 and resolved_at is null limit 1',
    [scope, shipmentId, chargeId, kind],
  );
  if (rows.length) return;
  await q('insert into haulback.queue (scope, shipment_id, charge_id, kind, why, detail) values ($1,$2,$3,$4,$5,$6::jsonb)', [
    scope, shipmentId, chargeId, kind, why, JSON.stringify(detail),
  ]);
}
export async function openQueue(scope = 'live'): Promise<any[]> {
  return q('select * from haulback.queue where scope=$1 and resolved_at is null order by created_at desc', [scope]);
}
export async function queueItem(scope: string, id: number): Promise<any | null> {
  const rows = await q('select * from haulback.queue where scope=$1 and id=$2', [scope, id]);
  return rows[0] ?? null;
}
export async function resolveQueue(scope: string, id: number, resolution: string): Promise<void> {
  await q('update haulback.queue set resolved_at=now(), resolution=$3 where scope=$1 and id=$2 and resolved_at is null', [scope, id, resolution]);
}

export async function suppress(scope: string, shipmentId: string, reason: string): Promise<void> {
  await q(
    `insert into haulback.suppressions (scope, shipment_id, reason) values ($1,$2,$3)
     on conflict (scope, shipment_id) do update set reason=excluded.reason, at=now()`,
    [scope, shipmentId, reason],
  );
}
export async function suppressed(scope: string): Promise<Set<string>> {
  const rows = await q('select shipment_id from haulback.suppressions where scope=$1', [scope]);
  return new Set(rows.map((r) => String(r.shipment_id)));
}

export async function upsertClaimTrial(scope: string, t: {
  claimId: string; shipmentId: string; chargeId: string; carrier: string; category: ClaimCategory; bundle: Bundle; stage: 'initial' | 'appeal'; amountCents: number;
}): Promise<void> {
  await q(
    `insert into haulback.claim_trials
       (scope, claim_id, shipment_id, charge_id, carrier, category, bundle, stage, amount_cents)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (scope, claim_id) do nothing`,
    [scope, t.claimId, t.shipmentId, t.chargeId, t.carrier, t.category, t.bundle, t.stage, t.amountCents],
  );
}

// Resolve the trial exactly once into learning stats. approved and
// credited both mean the bundle won; credited should not double count.
export async function resolveClaimTrial(scope: string, claimId: string, status: 'approved' | 'credited' | 'denied'): Promise<void> {
  const outcome = status === 'denied' ? 'denied' : status;
  const rows = await q(
    `update haulback.claim_trials
        set outcome=$3, resolved_at=now(),
            recovered_cents = case when $3='denied' then 0 else amount_cents end
      where scope=$1 and claim_id=$2 and outcome='pending'
      returning carrier, category, bundle, amount_cents`,
    [scope, claimId, outcome],
  );
  const row = rows[0];
  if (!row) return;
  const won = outcome !== 'denied';
  await q(
    `insert into haulback.bundle_stats (scope, carrier, category, bundle, attempts, wins, filed_cents, recovered_cents)
     values ($1,$2,$3,$4,1,$5,$6,$7)
     on conflict (scope, carrier, category, bundle) do update set
       attempts = haulback.bundle_stats.attempts + 1,
       wins = haulback.bundle_stats.wins + $5,
       filed_cents = haulback.bundle_stats.filed_cents + $6,
       recovered_cents = haulback.bundle_stats.recovered_cents + $7`,
    [scope, row.carrier, row.category, row.bundle, won ? 1 : 0, Number(row.amount_cents), won ? Number(row.amount_cents) : 0],
  );
}

export async function bundleStats(scope: string): Promise<BundleStat[]> {
  const rows = await q('select * from haulback.bundle_stats where scope=$1 order by carrier, category, bundle', [scope]);
  return rows.map((r) => ({
    carrier: String(r.carrier),
    category: String(r.category) as ClaimCategory,
    bundle: String(r.bundle) as Bundle,
    attempts: Number(r.attempts),
    wins: Number(r.wins),
    filedCents: Number(r.filed_cents),
    recoveredCents: Number(r.recovered_cents),
  }));
}

export async function claimTrials(scope: string, shipmentIds?: string[]): Promise<any[]> {
  if (shipmentIds?.length) {
    return q('select * from haulback.claim_trials where scope=$1 and shipment_id = any($2::text[]) order by created_at desc', [scope, shipmentIds]);
  }
  return q('select * from haulback.claim_trials where scope=$1 order by created_at desc limit 500', [scope]);
}

export async function callsForRun(runId: number): Promise<any[]> {
  return q('select * from haulback.calls where run_id=$1 order by at desc limit 200', [runId]);
}
export async function recentCalls(limit = 100): Promise<any[]> {
  return q('select * from haulback.calls order by at desc limit $1', [limit]);
}

export async function resetScope(scope: string): Promise<void> {
  await withLock(812734, async () => {
    await q('delete from haulback.queue where scope=$1', [scope]);
    await q('delete from haulback.decisions where scope=$1', [scope]);
    await q('delete from haulback.claim_trials where scope=$1', [scope]);
    await q('delete from haulback.bundle_stats where scope=$1', [scope]);
    await q('delete from haulback.suppressions where scope=$1', [scope]);
    await q('delete from haulback.runs where scope=$1', [scope]);
    await q('delete from haulback.settings_history where scope=$1', [scope]);
    await q('delete from haulback.state where key like $1', [`%:${scope}`]);
  });
}
