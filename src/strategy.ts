import type { ClaimCategory, Finding, Shipment } from './rating.js';

// Haulback's learning edge: carriers do not accept the same proof in the
// same way. A claim segment is carrier + category. For each segment the
// agent experiments with lawful evidence bundles and learns from actual
// approvals/denials. It optimizes estimated net recovery, not just win
// rate, because a heavier evidence pack costs operator/system effort.

export const BUNDLES = ['lean', 'contract_first', 'operations_pack', 'full_evidence'] as const;
export type Bundle = (typeof BUNDLES)[number];

export const BUNDLE_LABEL: Record<Bundle, string> = {
  lean: 'Lean invoice proof',
  contract_first: 'Contract-first proof',
  operations_pack: 'Operations proof pack',
  full_evidence: 'Full evidence pack',
};

export const BUNDLE_COST_CENTS: Record<Bundle, number> = {
  lean: 25,
  contract_first: 60,
  operations_pack: 110,
  full_evidence: 175,
};

export const BUNDLE_TONE: Record<Bundle, string> = {
  lean: 'short and charge-specific; cite the invoice line and exact recalculation',
  contract_first: 'lead with the contract rate/fee rule, then the invoice calculation',
  operations_pack: 'lead with scan, weight/dimension, delivery, or address proof, then the calculation',
  full_evidence: 'complete indexed pack: contract, calculation, invoice, and operational proof',
};

export type BundleStat = {
  carrier: string;
  category: ClaimCategory;
  bundle: Bundle;
  attempts: number;
  wins: number;
  filedCents: number;
  recoveredCents: number;
};

export type ClaimTrial = {
  claimId: string;
  shipmentId: string;
  chargeId: string;
  carrier: string;
  category: ClaimCategory;
  bundle: Bundle;
  stage: 'initial' | 'appeal';
  amountCents: number;
  outcome: 'pending' | 'approved' | 'denied' | 'credited';
  recoveredCents: number;
};

let seedState = 987654321;
export function setBanditSeed(n: number): void {
  seedState = Math.abs(Math.floor(n)) || 1;
}
function rnd(): number {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}

export function segmentKey(carrier: string, category: ClaimCategory): string {
  return `${carrier}|${category}`;
}

export function estimatedNetCents(stat: BundleStat | undefined, bundle: Bundle, amountCents: number): number {
  // Bayesian-ish smoothing: one prior win in three prevents a single
  // early denial from looking like certain failure.
  const attempts = stat?.attempts ?? 0;
  const wins = stat?.wins ?? 0;
  const rate = (wins + 1) / (attempts + 3);
  return rate * amountCents - BUNDLE_COST_CENTS[bundle];
}

export function chooseBundle(
  stats: BundleStat[],
  carrier: string,
  category: ClaimCategory,
  amountCents: number,
  exploration = 0.15,
  enabledBundles: readonly Bundle[] = BUNDLES,
): Bundle {
  const pool = BUNDLES.filter((b) => enabledBundles.includes(b));
  const usable = pool.length ? pool : [...BUNDLES];
  const byBundle = new Map(stats.filter((s) => s.carrier === carrier && s.category === category).map((s) => [s.bundle, s]));
  const untried = usable.filter((b) => !(byBundle.get(b)?.attempts));
  if (untried.length) return untried[0];
  if (rnd() < exploration) return usable[Math.floor(rnd() * usable.length)];
  let best = usable[0];
  let bestNet = -Infinity;
  for (const b of usable) {
    const net = estimatedNetCents(byBundle.get(b), b, amountCents);
    if (net > bestNet) {
      bestNet = net;
      best = b;
    }
  }
  return best;
}

export function evidenceFor(bundle: Bundle, finding: Finding): string[] {
  const ops: string[] = ['invoice_lines', 'calculation'];
  switch (finding.category) {
    case 'service_guarantee':
      ops.push('tracking_timeline', 'delivery_proof');
      break;
    case 'rate_weight_zone':
      ops.push('scale_dimensions');
      break;
    case 'residential_fee':
    case 'delivery_area_fee':
    case 'address_correction_fee':
      ops.push('address_proof');
      break;
    case 'handling_fee':
      ops.push('scale_dimensions');
      break;
    case 'duplicate_charge':
    case 'not_tendered':
      if (finding.shipment.tendered) ops.push('tender_scan');
      break;
    default:
      break;
  }
  const available = availableEvidence(finding.shipment);
  const pick = (items: string[]) => [...new Set(items.filter((x) => available.includes(x)))];
  switch (bundle) {
    case 'lean':
      return pick(['invoice_lines']);
    case 'contract_first':
      return pick(['contract_rate', 'invoice_lines', 'calculation']);
    case 'operations_pack':
      return pick(ops);
    case 'full_evidence':
      return pick(['contract_rate', 'invoice_lines', 'calculation', 'tracking_timeline', 'delivery_proof', 'scale_dimensions', 'address_proof', 'tender_scan']);
  }
}

export function availableEvidence(s: Shipment): string[] {
  const out = ['invoice_lines', 'contract_rate', 'calculation', 'scale_dimensions', 'address_proof'];
  if (s.tendered) out.push('tender_scan', 'tracking_timeline');
  if (s.deliveredDay !== null) out.push('delivery_proof');
  return out;
}

export function sortFindings(findings: Finding[], stats: BundleStat[], worldDay: number): Finding[] {
  return [...findings].sort((a, b) => {
    const aDays = a.deadlineDay - worldDay;
    const bDays = b.deadlineDay - worldDay;
    const aUrgency = aDays <= 3 ? 0 : aDays <= 10 ? 1 : 2;
    const bUrgency = bDays <= 3 ? 0 : bDays <= 10 ? 1 : 2;
    if (aUrgency !== bUrgency) return aUrgency - bUrgency;
    const aBest = Math.max(...BUNDLES.map((bundle) => estimatedNetCents(stats.find((s) => s.carrier === a.shipment.carrier && s.category === a.category && s.bundle === bundle), bundle, a.amountCents)));
    const bBest = Math.max(...BUNDLES.map((bundle) => estimatedNetCents(stats.find((s) => s.carrier === b.shipment.carrier && s.category === b.category && s.bundle === bundle), bundle, b.amountCents)));
    if (bBest !== aBest) return bBest - aBest;
    return a.deadlineDay - b.deadlineDay;
  });
}
