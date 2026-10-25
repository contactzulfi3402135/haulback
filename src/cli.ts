import * as db from './db.js';
import * as ledger from './ledger.js';
import { auditShipments } from './rating.js';
import { loadSettings } from './settings.js';
import { runSweep } from './sweep.js';

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function arg(name: string, fallback = ''): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? fallback : fallback;
}
function numArg(name: string, fallback: number): number {
  const n = Number(arg(name, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
}

const HELP = `Haulback — carrier overcharge recovery agent

Usage:
  haulback stats
  haulback audit [--limit 20]
  haulback shipments [--carrier northstar]
  haulback claims [--status denied]
  haulback queue
  haulback settings
  haulback sweep [--force] [--model baseline:rules] [--advance-days 1]
  haulback advance-day [--days 1]
  haulback create-shipment --carrier northstar --service express --force-error late

Environment:
  DATABASE_URL  Postgres connection string for haulback.* state
  LEDGER_URL    Go carrier GraphQL endpoint (default http://localhost:8090/graphql)
  LEDGER_TOKEN  Optional bearer token for that endpoint
`;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'help';
  if (['help', '--help', '-h'].includes(cmd)) {
    console.log(HELP);
    return;
  }
  await db.migrate();

  if (cmd === 'stats') {
    const [s, claims] = await Promise.all([ledger.ledgerStats(), ledger.listClaims()]);
    const approvedCents = claims
      .filter((c) => ['approved', 'credited'].includes(c.status))
      .reduce((n, c) => n + (c.approvedCents || c.amountCents), 0);
    console.table({
      worldDay: s.worldDay,
      shipments: s.shipmentCount,
      invoicedShipments: s.invoicedShipmentCount,
      billed: money(s.billedCents),
      expected: money(s.expectedCents),
      currentlyClaimable: money(s.claimableCents),
      claims: s.filedClaims,
      approved: money(approvedCents),
      credited: money(s.creditedCents),
      approvedUncredited: money(s.approvedUncreditedCents),
      invalidClaims: s.invalidClaims,
    });
    return;
  }

  if (cmd === 'audit') {
    const stats = await ledger.ledgerStats();
    const [contracts, shipments] = await Promise.all([ledger.listContracts(), ledger.listShipments()]);
    const findings = auditShipments(shipments.filter((s) => s.invoiceDay <= stats.worldDay), contracts)
      .sort((a, b) => a.deadlineDay - b.deadlineDay || b.amountCents - a.amountCents)
      .slice(0, numArg('--limit', 20));
    for (const f of findings) {
      console.log(`${f.shipment.tracking} ${f.shipment.carrier} ${f.category} ${money(f.amountCents)} deadline day ${f.deadlineDay} — ${f.explanation}`);
    }
    return;
  }

  if (cmd === 'shipments') {
    const carrier = arg('--carrier');
    const shipments = (await ledger.listShipments()).filter((s) => !carrier || s.carrier === carrier);
    for (const s of shipments.slice(0, numArg('--limit', 50))) {
      const billed = s.charges.reduce((n, c) => n + c.totalCents, 0);
      console.log(`${s.id} ${s.tracking} ${s.carrier}/${s.service} ${s.origin}->${s.destination} billed ${money(billed)} invoice day ${s.invoiceDay}`);
    }
    return;
  }

  if (cmd === 'claims') {
    const status = arg('--status');
    const claims = (await ledger.listClaims()).filter((c) => !status || c.status === status);
    for (const c of claims.slice(0, numArg('--limit', 100))) {
      console.log(`${c.id} shipment=${c.shipmentId} ${c.category}/${c.stage} ${c.bundle} ${money(c.amountCents)} ${c.status}${c.denialText ? ` — ${c.denialText}` : ''}`);
    }
    return;
  }

  if (cmd === 'queue') {
    const rows = await db.openQueue(arg('--scope', 'live'));
    if (!rows.length) console.log('Human queue is empty.');
    for (const r of rows) console.log(`#${r.id} ${r.kind} shipment=${r.shipment_id} charge=${r.charge_id} — ${r.why}`);
    return;
  }

  if (cmd === 'settings') {
    console.log(JSON.stringify(await loadSettings(arg('--scope', 'live')), null, 2));
    return;
  }

  if (cmd === 'sweep') {
    const result = await runSweep({
      force: process.argv.includes('--force'),
      model: arg('--model') || undefined,
      advanceDays: numArg('--advance-days', 0),
      scope: arg('--scope', 'live'),
      print: true,
    });
    if (!result.acquired) console.log('Another Haulback sweep is already running; skipped.');
    return;
  }

  if (cmd === 'advance-day') {
    const days = Math.max(1, Math.min(30, numArg('--days', 1)));
    let stats = await ledger.ledgerStats();
    for (let i = 0; i < days; i++) stats = await ledger.advanceDay();
    console.log(`Carrier stand-in advanced to world day ${stats.worldDay}. Credited ${money(stats.creditedCents)}; approved-not-credited ${money(stats.approvedUncreditedCents)}.`);
    return;
  }

  if (cmd === 'create-shipment') {
    const stats = await ledger.ledgerStats();
    const shipDay = numArg('--ship-day', stats.worldDay);
    const shipment = await ledger.createShipment({
      carrier: arg('--carrier', 'northstar'),
      service: arg('--service', 'express'),
      customerRef: arg('--customer', 'CLI import'),
      origin: arg('--origin', 'Austin, TX'),
      destination: arg('--destination', 'Portland, OR'),
      zone: numArg('--zone', 5),
      billedZone: numArg('--billed-zone', 0),
      weightGrams: numArg('--weight-grams', 1200),
      billedWeightGrams: numArg('--billed-weight-grams', 0),
      lengthCm: numArg('--length-cm', 30),
      widthCm: numArg('--width-cm', 22),
      heightCm: numArg('--height-cm', 10),
      shipDay,
      invoiceDay: numArg('--invoice-day', stats.worldDay),
      promisedDay: numArg('--promised-day', shipDay + 2),
      deliveredDay: process.argv.includes('--undelivered') ? null : numArg('--delivered-day', shipDay + 2),
      residential: process.argv.includes('--residential'),
      deliveryArea: process.argv.includes('--delivery-area'),
      addressCorrected: process.argv.includes('--address-corrected'),
      handlingRequired: process.argv.includes('--handling-required'),
      tendered: !process.argv.includes('--not-tendered'),
      guaranteeSuspended: process.argv.includes('--guarantee-suspended'),
      contractAmbiguous: process.argv.includes('--contract-ambiguous'),
      note: arg('--note', ''),
      forceError: arg('--force-error', ''),
    });
    console.log(`Created ${shipment.id} ${shipment.tracking}; billed ${money(shipment.charges.reduce((n, c) => n + c.totalCents, 0))}.`);
    return;
  }

  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exitCode = 2;
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => undefined);
  });
