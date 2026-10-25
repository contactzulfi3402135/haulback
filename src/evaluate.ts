import { mkdirSync, writeFileSync } from 'node:fs';
import * as db from './db.js';
import { runEngine, syncClaimOutcomes, type EngineMode } from './engine.js';
import * as ledger from './ledger.js';
import { auditShipments } from './rating.js';
import { defaultSettings, saveSettings, type AgentSettings } from './settings.js';
import { BUNDLE_COST_CENTS, setBanditSeed, type Bundle } from './strategy.js';
import { asset } from './assets.js';

// Fair episode evaluator. Every mode gets the same seeded carrier
// world and the same deterministic audit math:
// - none: carrier invoices are left alone
// - simple: audit + lean evidence for every eligible finding, no
//   learning, no appeals, no missing-credit chase
// - haulback: deadline/value order, learned evidence bundle, one
//   bounded appeal, and approved-versus-posted reconciliation
//
// SAFETY: this resets the connected carrier world. It refuses to run
// unless HAULBACK_EVAL_CONFIRM=reset-world, and should only point at a
// sandbox/eval ledger and database.

type Metrics = {
  mode: EngineMode;
  model: string;
  seed: number;
  days: number;
  shipments: number;
  billedCents: number;
  expectedCents: number;
  supportedPoolCents: number;
  claimsFiled: number;
  appealsFiled: number;
  creditsChased: number;
  approvedCents: number;
  creditedCents: number;
  approvedUncreditedCents: number;
  totalClaimAttempts: number;
  validClaims: number;
  invalidClaims: number;
  decidedClaims: number;
  approvedClaims: number;
  deniedClaims: number;
  precision: number;
  approvalRate: number;
  missedDeadlines: number;
  queued: number;
  handlingCostCents: number;
  modelCostUsd: number;
  netCreditedCents: number;
  recoveryRate: number;
  modelCalls: number;
  modelMs: number;
  episodeMs: number;
};

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

function handlingCost(claims: ledger.CarrierClaim[]): number {
  let cents = 0;
  for (const c of claims) {
    cents += (c.stage === 'appeal' ? 200 : 150) + (BUNDLE_COST_CENTS[c.bundle as Bundle] ?? 100);
    if (c.creditChasedDay !== null) cents += 50;
  }
  return cents;
}

async function runEpisode(mode: EngineMode, model: string, seed: number, days: number): Promise<Metrics> {
  const scope = `eval-${mode}-${seed}`;
  const started = Date.now();
  await ledger.resetWorld(seed);
  const [poolContracts, poolShipments] = await Promise.all([ledger.listContracts(), ledger.listShipments()]);
  const supportedPoolCents = auditShipments(poolShipments, poolContracts).reduce((n, f) => n + f.amountCents, 0);
  await db.resetScope(scope);

  const settings: AgentSettings = {
    ...defaultSettings(),
    draftModel: mode === 'haulback' ? model : 'baseline:rules',
    budgetUsd: 100,
    maxClaimsPerSweep: 500,
    minClaimCents: 200,
    toleranceCents: 25,
    humanAboveCents: 25000,
    creditGraceDays: 2,
    explorationPct: 15,
  };
  await saveSettings(scope, settings, 'evaluator');
  setBanditSeed(seed + (mode === 'haulback' ? 7001 : mode === 'simple' ? 3001 : 1001));

  const runId = await db.startRun('eval', settings.draftModel, scope, `${mode} episode`);
  let claimsFiled = 0;
  let appealsFiled = 0;
  let creditsChased = 0;
  let queued = 0;

  for (let day = 0; day < days; day++) {
    const s = await runEngine({ runId, scope, mode, settings, runActions: true });
    claimsFiled += s.claimsFiled;
    appealsFiled += s.appealsFiled;
    creditsChased += s.creditsChased;
    queued += s.queued;
    await ledger.advanceDay();
  }
  // Let final carrier decisions/credits settle, then sync outcomes.
  await syncClaimOutcomes(scope);

  const [stats, claims, contracts, shipments, calls] = await Promise.all([
    ledger.ledgerStats(),
    ledger.listClaims(),
    ledger.listContracts(),
    ledger.listShipments(),
    db.callsForRun(runId),
  ]);

  const decided = claims.filter((c) => c.status !== 'submitted');
  const approvedClaims = claims.filter((c) => ['approved', 'credited'].includes(c.status)).length;
  const deniedClaims = claims.filter((c) => c.status === 'denied').length;
  const initialKeys = new Set(claims.filter((c) => c.stage === 'initial').map((c) => `${c.shipmentId}|${c.chargeId}|${c.category}`));
  const missedDeadlines = auditShipments(shipments, contracts).filter((f) =>
    f.amountCents >= settings.minClaimCents &&
    f.amountCents > settings.toleranceCents &&
    f.deadlineDay < stats.worldDay &&
    !initialKeys.has(`${f.shipment.id}|${f.charge.id}|${f.category}`),
  ).length;

  const handling = handlingCost(claims);
  const modelCostUsd = calls.reduce((n, c) => n + Number(c.cost_usd), 0);
  const approvedCents = claims
    .filter((c) => ['approved', 'credited'].includes(c.status))
    .reduce((n, c) => n + (c.approvedCents || c.amountCents), 0);
  const metrics: Metrics = {
    mode,
    model: settings.draftModel,
    seed,
    days,
    shipments: stats.shipmentCount,
    billedCents: stats.billedCents,
    expectedCents: stats.expectedCents,
    supportedPoolCents,
    claimsFiled,
    appealsFiled,
    creditsChased,
    approvedCents,
    creditedCents: stats.creditedCents,
    approvedUncreditedCents: stats.approvedUncreditedCents,
    totalClaimAttempts: stats.filedClaims,
    validClaims: stats.validClaims,
    invalidClaims: stats.invalidClaims,
    decidedClaims: decided.length,
    approvedClaims,
    deniedClaims,
    precision: stats.filedClaims ? stats.validClaims / stats.filedClaims : 0,
    approvalRate: decided.length ? approvedClaims / decided.length : 0,
    missedDeadlines,
    queued,
    handlingCostCents: handling,
    modelCostUsd: Number(modelCostUsd.toFixed(6)),
    netCreditedCents: Math.round(stats.creditedCents - handling - modelCostUsd * 100),
    recoveryRate: supportedPoolCents ? stats.creditedCents / supportedPoolCents : 0,
    modelCalls: calls.length,
    modelMs: calls.reduce((n, c) => n + Number(c.ms), 0),
    episodeMs: Date.now() - started,
  };
  await db.finishRun(runId, metrics);
  return metrics;
}

async function main(): Promise<void> {
  if (process.env.HAULBACK_EVAL_CONFIRM !== 'reset-world') {
    throw new Error('Refusing to reset a carrier world. Set HAULBACK_EVAL_CONFIRM=reset-world and point LEDGER_URL/DATABASE_URL at sandbox services.');
  }
  const args = process.argv.slice(2);
  const get = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] ?? fallback : fallback;
  };
  const model = get('--draft-model', process.env.DRAFT_MODEL ?? 'baseline:rules');
  const seed = Number(get('--seed', '20261025'));
  const days = Number(get('--days', '75'));
  if (!Number.isInteger(seed) || !Number.isInteger(days) || days < 10 || days > 365) throw new Error('Invalid --seed or --days');

  await db.migrate();
  if (!(await ledger.ledgerHealth())) throw new Error('Carrier ledger health check failed');

  const results: Metrics[] = [];
  for (const mode of ['none', 'simple', 'haulback'] as EngineMode[]) {
    console.log(`\n== ${mode} ==`);
    const m = await runEpisode(mode, model, seed, days);
    results.push(m);
    console.table({
      credited: money(m.creditedCents),
      netCredited: money(m.netCreditedCents),
      recoveryRate: pct(m.recoveryRate),
      claims: m.claimsFiled,
      appeals: m.appealsFiled,
      claimPrecision: pct(m.precision),
      approvalRate: pct(m.approvalRate),
      invalid: m.invalidClaims,
      missedDeadlines: m.missedDeadlines,
      uncredited: money(m.approvedUncreditedCents),
      modelCost: `$${m.modelCostUsd.toFixed(4)}`,
    });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = asset('results');
  mkdirSync(dir, { recursive: true });
  const jsonPath = `${dir}/eval-${stamp}.json`;
  const mdPath = `${dir}/eval-${stamp}.md`;
  writeFileSync(jsonPath, JSON.stringify({ model, seed, days, results }, null, 2));

  const lines = [
    `# Haulback evaluation — ${stamp}`,
    '',
    `Seed ${seed}; ${days} simulated carrier days; draft model \`${model}\`. Same seeded world and audit math for every mode.`,
    '',
    '| Mode | Credited | Net after handling/model | Recovery of supported pool | Initial claims | Appeals | Claim precision | Approval rate | Invalid | Missed deadlines | Approved not credited | Model cost |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map((m) => `| ${m.mode} | ${money(m.creditedCents)} | ${money(m.netCreditedCents)} | ${pct(m.recoveryRate)} | ${m.claimsFiled} | ${m.appealsFiled} | ${pct(m.precision)} | ${pct(m.approvalRate)} | ${m.invalidClaims} | ${m.missedDeadlines} | ${money(m.approvedUncreditedCents)} | $${m.modelCostUsd.toFixed(4)} |`),
    '',
    `World: ${results[0].shipments} shipments; billed ${money(results[0].billedCents)}; contract-expected ${money(results[0].expectedCents)}; category-supported claim pool ${money(results[0].supportedPoolCents)}.`,
    '',
    'Definitions: claim precision is simulator-valid claim attempts divided by all claim attempts (initial + appeals). Approval rate is approved-or-credited claims divided by decided claims. A mode with zero attempts therefore reports 0% rather than a meaningful precision estimate.',
    '',
    'Handling cost model: $1.50 per initial claim, $2.00 per appeal, $0.25–$1.75 evidence-pack preparation, and $0.50 per credit chase. These are evaluator assumptions, not carrier facts.',
    '',
    'This is a fictional Go carrier stand-in. It proves the workflow and measurement discipline; it is not evidence of recovery from a real carrier account.',
  ];
  writeFileSync(mdPath, lines.join('\n') + '\n');
  console.log(`\nWrote ${jsonPath}\nWrote ${mdPath}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => undefined);
  });
