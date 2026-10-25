import * as db from './db.js';
import { creditChaseMessage, draftClaim, templateDraft } from './draft.js';
import * as ledger from './ledger.js';
import type { CarrierClaim } from './ledger.js';
import { bannedPhraseIn, gateClaim, type ClaimDraft, type ExistingClaim } from './policy.js';
import { auditShipments, type Finding } from './rating.js';
import type { AgentSettings } from './settings.js';
import { sortFindings, type BundleStat } from './strategy.js';

// The operating loop. Deterministic code recalculates every invoice.
// Haulback then drafts claims, passes them through hard policy, files
// them in the carrier system, learns from carrier outcomes, makes one
// bounded appeal, and reconciles approved credits against posted
// credits. The simple baseline uses the same audit math but one lean
// bundle, no learning, no appeals, and no credit chasing.

export type EngineMode = 'none' | 'simple' | 'haulback';

export type SweepStats = {
  worldDay: number;
  shipmentsAudited: number;
  chargesAudited: number;
  findings: number;
  findingCents: number;
  deadlineRisk: number;
  claimsFiled: number;
  claimsValueCents: number;
  appealsFiled: number;
  creditsChased: number;
  queued: number;
  waits: number;
  skipped: number;
  failed: number;
  outcomesSynced: number;
  budgetStopped: boolean;
};

const emptyStats = (worldDay: number): SweepStats => ({
  worldDay,
  shipmentsAudited: 0,
  chargesAudited: 0,
  findings: 0,
  findingCents: 0,
  deadlineRisk: 0,
  claimsFiled: 0,
  claimsValueCents: 0,
  appealsFiled: 0,
  creditsChased: 0,
  queued: 0,
  waits: 0,
  skipped: 0,
  failed: 0,
  outcomesSynced: 0,
  budgetStopped: false,
});

export function modeFromModel(model: string): EngineMode {
  if (model === 'none') return 'none';
  if (model === 'simple' || model === 'template' || model === 'baseline:simple') return 'simple';
  return 'haulback';
}

export function effectiveSettings(settings: AgentSettings, mode: EngineMode): AgentSettings {
  if (mode !== 'simple') return settings;
  return {
    ...settings,
    enabledBundles: ['lean'],
    explorationPct: 0,
    appealEnabled: false,
    creditGraceDays: 999,
  };
}

export async function syncClaimOutcomes(scope: string, claims = undefined as CarrierClaim[] | undefined): Promise<number> {
  const all = claims ?? await ledger.listClaims();
  let n = 0;
  for (const c of all) {
    if (c.status === 'submitted') continue;
    const before = await db.q('select outcome from haulback.claim_trials where scope=$1 and claim_id=$2', [scope, c.id]);
    if (before[0]?.outcome === 'pending') n++;
    await db.resolveClaimTrial(scope, c.id, c.status);
  }
  return n;
}

type ProcessOptions = {
  runId: number;
  scope: string;
  finding: Finding;
  claims: CarrierClaim[];
  settings: AgentSettings;
  mode: EngineMode;
  stats: BundleStat[];
  parentClaim?: CarrierClaim | null;
  humanApproved?: boolean;
  overrideDraft?: ClaimDraft;
  runActions?: boolean;
};

export type ProcessResult = {
  outcome: string;
  reason: string;
  claim?: CarrierClaim;
  draft?: ClaimDraft;
};

function mapExisting(claims: CarrierClaim[]): ExistingClaim[] {
  return claims.map((c) => ({
    id: c.id,
    shipmentId: c.shipmentId,
    chargeId: c.chargeId,
    category: c.category,
    stage: c.stage,
    parentClaimId: c.parentClaimId,
    status: c.status,
    amountCents: c.amountCents,
  }));
}

export async function processFinding(o: ProcessOptions): Promise<ProcessResult> {
  const { finding, scope } = o;
  const settings = effectiveSettings(o.settings, o.mode);
  const worldDay = (await ledger.ledgerStats()).worldDay;
  const say = async (action: string, outcome: string, why: string, bundle = '') => {
    await db.recordDecision(o.runId, {
      scope,
      shipmentId: finding.shipment.id,
      chargeId: finding.charge.id,
      worldDay,
      carrier: finding.shipment.carrier,
      category: finding.category,
      bundle,
      action,
      outcome,
      why,
    });
  };

  if (o.mode === 'none') return { outcome: 'wait', reason: 'No-action baseline' };
  if (!o.runActions) return { outcome: 'preview', reason: 'Actions are disabled for this run' };

  let draft: ClaimDraft;
  try {
    if (o.overrideDraft) draft = o.overrideDraft;
    else if (o.mode === 'simple') {
      draft = templateDraft(finding, settings, { mode: 'simple', stats: [], deniedClaim: null });
    } else if (!o.humanApproved && (finding.shipment.contractAmbiguous || finding.amountCents > settings.humanAboveCents || (!o.parentClaim && worldDay > finding.deadlineDay))) {
      // Known human-owned cases do not need a paid model call. Build
      // the editable template draft and let policy queue exact reason.
      draft = templateDraft(finding, settings, { mode: 'haulback', stats: o.stats, deniedClaim: o.parentClaim ?? null });
    } else {
      draft = await draftClaim(o.runId, finding, settings, {
        mode: settings.draftModel.startsWith('baseline:') ? 'baseline' : 'llm',
        stats: o.stats,
        deniedClaim: o.parentClaim ?? null,
      });
    }
  } catch (e) {
    const reason = `Drafting failed: ${e instanceof Error ? e.message : String(e)}`;
    await db.enqueue(scope, finding.shipment.id, finding.charge.id, 'claim_review', reason, {
      category: finding.category,
      amountCents: finding.amountCents,
      deadlineDay: finding.deadlineDay,
    });
    await say('draft', 'failed', reason);
    return { outcome: 'failed', reason };
  }

  // The model must respect the task shape: a denied claim gets an
  // appeal, a fresh finding gets an initial claim.
  if (o.parentClaim && draft.action === 'file_claim') draft = { ...draft, action: 'appeal_claim' };
  if (!o.parentClaim && draft.action === 'appeal_claim') draft = { ...draft, action: 'file_claim' };

  const verdict = gateClaim(draft, finding, mapExisting(o.claims), {
    worldDay,
    minClaimCents: settings.minClaimCents,
    toleranceCents: settings.toleranceCents,
    humanAboveCents: settings.humanAboveCents,
    enabledBundles: settings.enabledBundles,
    humanApproved: !!o.humanApproved,
    parentClaim: o.parentClaim ? mapExisting([o.parentClaim])[0] : null,
  });

  if (!verdict.ok) {
    if (verdict.outcome === 'queued') {
      await db.enqueue(scope, finding.shipment.id, finding.charge.id, 'claim_review', verdict.reason, {
        category: finding.category,
        amountCents: finding.amountCents,
        deadlineDay: finding.deadlineDay,
        explanation: finding.explanation,
        draft,
        parentClaimId: o.parentClaim?.id ?? '',
      });
      await say(draft.action, 'queued', verdict.reason, draft.bundle);
      return { outcome: 'queued', reason: verdict.reason, draft };
    }
    await say(draft.action, 'wait', verdict.reason, draft.bundle);
    return { outcome: 'wait', reason: verdict.reason, draft };
  }

  if (verdict.action === 'wait') {
    await say('wait', 'wait', draft.why, draft.bundle);
    return { outcome: 'wait', reason: draft.why, draft };
  }
  if (verdict.action === 'escalate') {
    const reason = `Agent escalated: ${draft.why}`;
    await db.enqueue(scope, finding.shipment.id, finding.charge.id, 'claim_review', reason, {
      category: finding.category,
      amountCents: finding.amountCents,
      deadlineDay: finding.deadlineDay,
      explanation: finding.explanation,
      draft,
      parentClaimId: o.parentClaim?.id ?? '',
    });
    await say('escalate', 'queued', reason, draft.bundle);
    return { outcome: 'queued', reason, draft };
  }
  if (verdict.action === 'chase_credit') {
    return { outcome: 'wait', reason: 'Credit chasing is handled from approved claim state, not a fresh finding.', draft };
  }

  const stage = verdict.action === 'appeal_claim' ? 'appeal' as const : 'initial' as const;
  const idempotencyKey = `${scope}:${finding.shipment.id}:${finding.charge.id}:${finding.category}:${stage}`;
  try {
    const claim = stage === 'appeal'
      ? await ledger.appealClaim(o.parentClaim!.id, draft.bundle, verdict.evidence, draft.message, idempotencyKey)
      : await ledger.fileClaim({
          shipmentId: finding.shipment.id,
          chargeId: finding.charge.id,
          category: finding.category,
          amountCents: finding.amountCents,
          bundle: draft.bundle,
          evidence: verdict.evidence,
          message: draft.message,
          idempotencyKey,
        });
    await db.upsertClaimTrial(scope, {
      claimId: claim.id,
      shipmentId: finding.shipment.id,
      chargeId: finding.charge.id,
      carrier: finding.shipment.carrier,
      category: finding.category,
      bundle: draft.bundle,
      stage,
      amountCents: finding.amountCents,
    });
    await say(draft.action, claim.status, `${draft.why} Evidence: ${verdict.evidence.join(', ')}.`, draft.bundle);
    return { outcome: claim.status, reason: draft.why, claim, draft };
  } catch (e) {
    const reason = `Carrier write failed: ${e instanceof Error ? e.message : String(e)}`;
    await say(draft.action, 'failed', reason, draft.bundle);
    return { outcome: 'failed', reason, draft };
  }
}

export async function chaseApprovedCredit(scope: string, claimId: string, runId = 0, customMessage?: string): Promise<CarrierClaim> {
  const claim = await ledger.getClaim(claimId);
  if (!claim) throw new Error('Claim not found');
  if (claim.status !== 'approved') throw new Error(`Only an approved-but-uncredited claim can be chased (current: ${claim.status})`);
  const shipment = await ledger.getShipment(claim.shipmentId);
  const message = customMessage?.trim() || creditChaseMessage(claim, shipment?.tracking ?? claim.shipmentId);
  const banned = bannedPhraseIn(message);
  if (banned) throw new Error(`Message contains banned phrase: ${banned}`);
  const stats = await ledger.ledgerStats();
  const updated = await ledger.chaseCredit(claim.id, message, `${scope}:${claim.id}:credit-chase:${stats.worldDay}`);
  await db.recordDecision(runId, {
    scope,
    shipmentId: claim.shipmentId,
    chargeId: claim.chargeId,
    worldDay: stats.worldDay,
    carrier: shipment?.carrier ?? '',
    category: claim.category,
    bundle: claim.bundle,
    action: 'chase_credit',
    outcome: updated.status,
    why: 'Approved credit had not posted; Haulback reconciled the carrier promise against the invoice and chased it.',
  });
  return updated;
}

export type RunEngineOptions = {
  runId: number;
  scope: string;
  mode: EngineMode;
  settings: AgentSettings;
  runActions?: boolean;
  print?: boolean;
};

export async function runEngine(o: RunEngineOptions): Promise<SweepStats> {
  db.resetAgg();
  const settings = effectiveSettings(o.settings, o.mode);
  const ledgerStats = await ledger.ledgerStats();
  const worldDay = ledgerStats.worldDay;
  const stats = emptyStats(worldDay);

  const [contracts, shipments] = await Promise.all([ledger.listContracts(), ledger.listShipments()]);
  let claims = await ledger.listClaims();
  stats.outcomesSynced = await syncClaimOutcomes(o.scope, claims);
  claims = await ledger.listClaims();

  // Approved is not recovered. Reconcile carrier promises against
  // credits that actually posted, then chase only after the grace.
  if (o.mode === 'haulback' && o.runActions) {
    for (const claim of claims.filter((c) => c.status === 'approved')) {
      if (claim.creditDueDay !== null && worldDay > claim.creditDueDay + settings.creditGraceDays) {
        try {
          await chaseApprovedCredit(o.scope, claim.id, o.runId);
          stats.creditsChased++;
        } catch (e) {
          stats.failed++;
          await db.enqueue(o.scope, claim.shipmentId, claim.chargeId, 'credit_missing', `Credit chase failed: ${e instanceof Error ? e.message : String(e)}`, { claimId: claim.id, amountCents: claim.amountCents });
        }
      }
    }
    claims = await ledger.listClaims();
  }

  const visibleShipments = shipments.filter((s) => s.invoiceDay <= worldDay && settings.enabledCarriers.includes(s.carrier as any));
  stats.shipmentsAudited = visibleShipments.length;
  stats.chargesAudited = visibleShipments.reduce((n, s) => n + s.charges.length, 0);

  let findings = auditShipments(visibleShipments, contracts).filter((f) => {
    if (!settings.enabledCategories.includes(f.category)) return false;
    if (f.charge.invoiceDay > worldDay) return false;
    if (f.category === 'service_guarantee' && (f.shipment.deliveredDay === null || f.shipment.deliveredDay > worldDay)) return false;
    return true;
  });
  stats.findings = findings.length;
  stats.findingCents = findings.reduce((n, f) => n + f.amountCents, 0);
  stats.deadlineRisk = findings.filter((f) => f.deadlineDay >= worldDay && f.deadlineDay - worldDay <= 3).length;

  if (o.mode === 'none' || !o.runActions) return stats;

  const suppressedIds = await db.suppressed(o.scope);
  const open = await db.openQueue(o.scope);
  const queuedKeys = new Set(open.filter((x) => x.kind === 'claim_review').map((x) => `${x.shipment_id}|${x.charge_id}`));
  const bundleStats = await db.bundleStats(o.scope);
  findings = sortFindings(findings, bundleStats, worldDay);

  type Task = { finding: Finding; parentClaim?: CarrierClaim | null };
  const tasks: Task[] = [];
  for (const finding of findings) {
    if (suppressedIds.has(finding.shipment.id)) {
      stats.skipped++;
      continue;
    }
    if (queuedKeys.has(`${finding.shipment.id}|${finding.charge.id}`)) {
      stats.skipped++;
      continue;
    }
    if (finding.amountCents < settings.minClaimCents || finding.amountCents <= settings.toleranceCents) {
      stats.skipped++;
      continue;
    }
    const same = claims.filter((c) => c.shipmentId === finding.shipment.id && c.chargeId === finding.charge.id && c.category === finding.category);
    const deniedInitial = same.find((c) => c.stage === 'initial' && c.status === 'denied') ?? null;
    if (deniedInitial) {
      if (settings.appealEnabled && !same.some((c) => c.stage === 'appeal')) tasks.push({ finding, parentClaim: deniedInitial });
      else stats.skipped++;
      continue;
    }
    if (same.some((c) => c.stage === 'initial')) {
      stats.skipped++;
      continue;
    }
    tasks.push({ finding, parentClaim: null });
  }

  let acted = 0;
  for (const task of tasks) {
    if (acted >= settings.maxClaimsPerSweep) break;
    if (db.agg.cost > settings.budgetUsd) {
      stats.budgetStopped = true;
      break;
    }
    acted++;
    const result = await processFinding({
      runId: o.runId,
      scope: o.scope,
      finding: task.finding,
      claims,
      settings,
      mode: o.mode,
      stats: bundleStats,
      parentClaim: task.parentClaim,
      runActions: true,
    });
    if (result.claim) {
      claims.push(result.claim);
      if (task.parentClaim) stats.appealsFiled++;
      else {
        stats.claimsFiled++;
        stats.claimsValueCents += task.finding.amountCents;
      }
    } else if (result.outcome === 'queued') stats.queued++;
    else if (result.outcome === 'failed') stats.failed++;
    else stats.waits++;
  }

  if (o.print) {
    console.log(`Haulback day ${worldDay}: audited ${stats.shipmentsAudited} shipments, found ${stats.findings} supported findings, filed ${stats.claimsFiled}, appealed ${stats.appealsFiled}, queued ${stats.queued}.`);
  }
  return stats;
}
