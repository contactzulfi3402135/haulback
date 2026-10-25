import * as db from '../src/db.js';
import * as ledger from '../src/ledger.js';

// Reset the fictional carrier world to its deterministic seed.
// This intentionally refuses without the same explicit confirmation
// as the evaluator, because a persistent live stand-in would lose its
// history if this were run by mistake.
async function main(): Promise<void> {
  if (process.env.HAULBACK_EVAL_CONFIRM !== 'reset-world') {
    throw new Error('Refusing to reset a carrier world. Set HAULBACK_EVAL_CONFIRM=reset-world only for a sandbox/eval ledger.');
  }
  await db.migrate();
  if (!(await ledger.ledgerHealth())) throw new Error('Carrier ledger health check failed');
  const seed = Number(process.argv[2] ?? 20261025);
  const stats = await ledger.resetWorld(seed);
  console.log(`Seeded ${stats.shipmentCount} fictional shipments (seed ${seed}). Currently invoiced billed $${(stats.billedCents / 100).toFixed(2)}; currently claimable $${(stats.claimableCents / 100).toFixed(2)}.`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; })
  .finally(async () => { await db.pool.end().catch(() => undefined); });
