import { readFileSync } from 'node:fs';
import { asset } from './assets.js';
import type { Finding } from './rating.js';
import { BUNDLES, evidenceFor, type Bundle } from './strategy.js';

// Claim law for Haulback. Deterministic rating code finds the money; an
// LLM may propose words/a bundle. This gate decides whether anything may
// be filed. Carrier notes and denial text are untrusted data and can
// never change the amount, deadline, or evidence rules.

export type ClaimPolicy = {
  max_appeals_per_claim: number;
  claim_amount_tolerance_cents: number;
  require_evidence: boolean;
  banned_phrases: string[];
};

export const POLICY: ClaimPolicy = JSON.parse(readFileSync(asset('policy/claims.json'), 'utf8')) as ClaimPolicy;

export type ClaimAction = 'wait' | 'file_claim' | 'appeal_claim' | 'chase_credit' | 'escalate';
export type ClaimDraft = {
  action: ClaimAction;
  bundle: Bundle;
  message: string;
  why: string;
};

const ACTIONS: readonly string[] = ['wait', 'file_claim', 'appeal_claim', 'chase_credit', 'escalate'];

export function checkDraft(raw: unknown): ClaimDraft {
  if (typeof raw !== 'object' || raw === null) throw new Error('draft is not an object');
  const d = raw as Record<string, unknown>;
  if (typeof d.action !== 'string' || !ACTIONS.includes(d.action)) throw new Error(`draft.action must be one of ${ACTIONS.join(', ')}`);
  if (typeof d.bundle !== 'string' || !(BUNDLES as readonly string[]).includes(d.bundle)) throw new Error(`draft.bundle must be one of ${BUNDLES.join(', ')}`);
  if (typeof d.why !== 'string' || !d.why.trim()) throw new Error('draft.why must say why');
  const message = typeof d.message === 'string' ? d.message : '';
  if (['file_claim', 'appeal_claim', 'chase_credit'].includes(d.action) && !message.trim()) throw new Error('a carrier-facing draft needs a message');
  return {
    action: d.action as ClaimAction,
    bundle: d.bundle as Bundle,
    message: message.slice(0, 1200),
    why: d.why.trim().slice(0, 400),
  };
}

export function bannedPhraseIn(message: string, p: ClaimPolicy = POLICY): string | null {
  const text = message.toLowerCase();
  for (const phrase of p.banned_phrases) if (text.includes(phrase)) return phrase;
  return null;
}

export type ExistingClaim = {
  id: string;
  shipmentId: string;
  chargeId: string;
  category: string;
  stage: string;
  parentClaimId: string;
  status: string;
  amountCents: number;
};

export type GateOptions = {
  worldDay: number;
  minClaimCents: number;
  toleranceCents: number;
  humanAboveCents: number;
  enabledBundles: readonly Bundle[];
  humanApproved?: boolean;
  parentClaim?: ExistingClaim | null;
};

export type Verdict =
  | { ok: true; action: ClaimAction; evidence: string[] }
  | { ok: false; outcome: 'wait' | 'queued'; reason: string };

export function gateClaim(
  draft: ClaimDraft,
  finding: Finding,
  existingClaims: ExistingClaim[],
  o: GateOptions,
  p: ClaimPolicy = POLICY,
): Verdict {
  if (draft.action === 'wait') return { ok: true, action: 'wait', evidence: [] };
  if (draft.action === 'escalate') return { ok: true, action: 'escalate', evidence: [] };
  if (draft.action === 'chase_credit') {
    // Credit chasing is gated by claim state in the engine/dashboard
    // action because it does not belong to a fresh Finding amount.
    const banned = bannedPhraseIn(draft.message, p);
    if (banned) return { ok: false, outcome: 'queued', reason: `Draft contained banned phrase "${banned}"; blocked and sent to a person.` };
    return { ok: true, action: draft.action, evidence: ['invoice_lines'] };
  }

  if (!o.enabledBundles.includes(draft.bundle)) {
    return { ok: false, outcome: 'queued', reason: `Evidence bundle ${draft.bundle} is disabled by the operator.` };
  }
  const banned = bannedPhraseIn(draft.message, p);
  if (banned) return { ok: false, outcome: 'queued', reason: `Draft contained banned phrase "${banned}"; blocked and sent to a person.` };
  if (finding.amountCents < o.minClaimCents) {
    return { ok: false, outcome: 'wait', reason: `Supported amount is below the operator minimum claim threshold.` };
  }
  if (finding.amountCents <= o.toleranceCents) {
    return { ok: false, outcome: 'wait', reason: `Difference is inside the operator tolerance; do not spend effort claiming it.` };
  }
  if (draft.action === 'file_claim' && o.worldDay > finding.deadlineDay) {
    return { ok: false, outcome: 'queued', reason: `Automatic claim deadline passed on world day ${finding.deadlineDay}; a person must decide whether any exception path exists.` };
  }
  if (finding.shipment.contractAmbiguous && !o.humanApproved) {
    return { ok: false, outcome: 'queued', reason: 'Shipment note says a side agreement may change the charge; a person must verify the signed contract first.' };
  }
  if (finding.amountCents > o.humanAboveCents && !o.humanApproved) {
    return { ok: false, outcome: 'queued', reason: `Claim exceeds the operator auto-file limit; a person must approve it.` };
  }

  const same = existingClaims.filter((c) => c.shipmentId === finding.shipment.id && c.chargeId === finding.charge.id && c.category === finding.category);
  if (draft.action === 'file_claim') {
    if (same.some((c) => ['submitted', 'approved', 'credited'].includes(c.status))) {
      return { ok: false, outcome: 'wait', reason: 'An active or successful claim already exists for this exact charge/category.' };
    }
    if (same.some((c) => c.stage === 'initial')) {
      return { ok: false, outcome: 'wait', reason: 'An initial claim was already filed for this charge/category; use the bounded appeal path if it was denied.' };
    }
  }
  if (draft.action === 'appeal_claim') {
    if (!o.parentClaim || o.parentClaim.status !== 'denied') {
      return { ok: false, outcome: 'queued', reason: 'Only a denied claim can be appealed.' };
    }
    if (o.parentClaim.amountCents !== finding.amountCents) {
      return { ok: false, outcome: 'queued', reason: 'Appeal amount no longer matches deterministic recalculation; a person must inspect it.' };
    }
    const appeals = same.filter((c) => c.stage === 'appeal').length;
    if (appeals >= p.max_appeals_per_claim) {
      return { ok: false, outcome: 'queued', reason: `Appeal cap reached (${appeals}/${p.max_appeals_per_claim}); a person owns the case now.` };
    }
  }

  const evidence = evidenceFor(draft.bundle, finding);
  if (p.require_evidence && evidence.length === 0) {
    return { ok: false, outcome: 'queued', reason: 'No available evidence supports this bundle; a person must inspect the source records.' };
  }
  return { ok: true, action: draft.action, evidence };
}

export function denialSignal(text: string): 'contract' | 'operations' | 'concise' | 'unsupported' | 'deadline' | null {
  const t = text.toLowerCase();
  if (t.includes('outside_window') || t.includes('deadline')) return 'deadline';
  if (t.includes('amount_not_supported') || t.includes('does not support')) return 'unsupported';
  if (t.includes('contract')) return 'contract';
  if (t.includes('operational proof') || t.includes('scan') || t.includes('weight')) return 'operations';
  if (t.includes('not indexed') || t.includes('concise')) return 'concise';
  return null;
}
