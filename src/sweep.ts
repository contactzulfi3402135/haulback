import { pathToFileURL } from 'node:url';
import * as db from './db.js';
import { modeFromModel, runEngine, syncClaimOutcomes } from './engine.js';
import * as ledger from './ledger.js';
import { setBanditSeed } from './strategy.js';
import { loadSettings, scheduleStatus } from './settings.js';

// One unattended Haulback sweep. GitHub Actions (or a home machine)
// calls this. Dashboard settings still control pause/schedule unless
// --force is supplied. An advisory lock prevents overlapping sweeps.
// --advance-days is only for the fictional carrier stand-in: it moves
// simulated carrier time after the agent has acted.

export type SweepOptions = {
  force?: boolean;
  model?: string;
  advanceDays?: number;
  scope?: string;
  print?: boolean;
};

export async function runSweep(opts: SweepOptions = {}) {
  const scope = opts.scope ?? 'live';
  await db.migrate();
  const stored = await loadSettings(scope);
  const settings = opts.model ? { ...stored, draftModel: opts.model } : stored;
  const mode = modeFromModel(settings.draftModel);
  const schedule = scheduleStatus(settings);
  const runActions = !!opts.force || schedule.allowed;
  const advanceDays = Math.max(0, Math.min(30, Math.floor(opts.advanceDays ?? 0)));

  return db.tryWithLock(812733, async () => {
    const runId = await db.startRun('sweep', settings.draftModel, scope, opts.force ? 'manual/forced sweep' : 'scheduled sweep');
    try {
      if (!(await ledger.ledgerHealth())) throw new Error('Carrier ledger health check failed');
      const before = await ledger.ledgerStats();
      setBanditSeed(20261025 + before.worldDay);
      const stats = await runEngine({
        runId,
        scope,
        mode,
        settings,
        runActions,
        print: opts.print,
      });

      let outcomesAfterAdvance = 0;
      for (let i = 0; i < advanceDays; i++) await ledger.advanceDay();
      if (advanceDays) outcomesAfterAdvance = await syncClaimOutcomes(scope);
      const after = await ledger.ledgerStats();

      const finalStats = {
        ...stats,
        ranActions: runActions,
        schedule,
        advanceDays,
        outcomesAfterAdvance,
        ledger: after,
        modelCostUsd: Number(db.agg.cost.toFixed(6)),
        modelCalls: db.agg.calls,
      };
      await db.setState(db.scopeKey('last_sweep', scope), JSON.stringify({ at: new Date().toISOString(), worldDay: after.worldDay }));
      await db.finishRun(runId, finalStats);
      if (opts.print) {
        console.log(`sweep complete: run=${runId} worldDay ${before.worldDay}->${after.worldDay} actions=${runActions} schedule="${schedule.reason}"`);
        console.log(JSON.stringify(finalStats, null, 2));
      }
      return finalStats;
    } catch (e) {
      await db.finishRun(runId, { error: e instanceof Error ? e.message : String(e), schedule, ranActions: runActions });
      throw e;
    }
  });
}

function parseArgs(argv: string[]): SweepOptions {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    force: argv.includes('--force'),
    model: get('--model') ?? process.env.DRAFT_MODEL,
    advanceDays: Number(get('--advance-days') ?? process.env.ADVANCE_WORLD_DAYS ?? 0),
    scope: get('--scope') ?? 'live',
    print: true,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSweep(parseArgs(process.argv.slice(2)))
    .then(async (r) => {
      if (!r.acquired) console.log('Another Haulback sweep is already running; skipped.');
      await db.pool.end();
    })
    .catch(async (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      await db.pool.end().catch(() => undefined);
      process.exit(1);
    });
}
