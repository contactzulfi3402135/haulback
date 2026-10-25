import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import * as db from './db.js';
import { creditChaseMessage } from './draft.js';
import { chaseApprovedCredit, processFinding, syncClaimOutcomes } from './engine.js';
import * as ledger from './ledger.js';
import type { CarrierClaim, LedgerStats } from './ledger.js';
import { bannedPhraseIn } from './policy.js';
import {
  auditShipment,
  auditShipments,
  CLAIM_CATEGORIES,
  expectedFor,
  type CarrierContract,
  type ClaimCategory,
  type Finding,
  type Shipment,
} from './rating.js';
import {
  CARRIERS,
  defaultSettings,
  loadSettings,
  renderTemplate,
  saveSettings,
  scheduleStatus,
  type AgentSettings,
} from './settings.js';
import {
  BUNDLES,
  BUNDLE_COST_CENTS,
  BUNDLE_LABEL,
  chooseBundle,
  estimatedNetCents,
  sortFindings,
  type Bundle,
  type BundleStat,
} from './strategy.js';
import { runSweep } from './sweep.js';

// Haulback Control Room. The words are deliberately plain: this is a
// money-recovery desk, not a developer console. Every write still goes
// through the same deterministic rating + policy path as the sweep.

const PORT = Number(process.env.PORT ?? 8080);
const SCOPE = 'live';

const CATEGORY_LABEL: Record<ClaimCategory, string> = {
  service_guarantee: 'Late guaranteed delivery',
  duplicate_charge: 'Duplicate charge',
  not_tendered: 'Label never shipped',
  rate_weight_zone: 'Wrong rate, weight, or zone',
  fuel_surcharge: 'Fuel charged too high',
  residential_fee: 'Wrong home-delivery fee',
  delivery_area_fee: 'Wrong delivery-area fee',
  address_correction_fee: 'Wrong address-correction fee',
  handling_fee: 'Wrong handling fee',
};
const CATEGORY_HELP: Record<ClaimCategory, string> = {
  service_guarantee: 'A guaranteed express/priority service arrived late.',
  duplicate_charge: 'The carrier billed the same shipment more than once.',
  not_tendered: 'A label was billed but never handed to the carrier.',
  rate_weight_zone: 'The bill used the wrong billable weight, zone, discount, or rate.',
  fuel_surcharge: 'Fuel is above the percentage promised in the contract.',
  residential_fee: 'A home-delivery fee appeared on a business address.',
  delivery_area_fee: 'A remote/delivery-area fee appeared where it does not apply.',
  address_correction_fee: 'The carrier charged to fix an address that needed no fix.',
  handling_fee: 'Extra handling was charged when the parcel did not need it.',
};

function boolEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] ?? '').toLowerCase());
}
function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function authorized(req: IncomingMessage): boolean {
  const envName = ['REVIEW', 'PASSWORD'].join('_');
  const expected = process.env[envName] ?? '';
  if (!expected) return process.env.NODE_ENV !== 'production' || boolEnv('ALLOW_NO_AUTH');
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    const user = i >= 0 ? decoded.slice(0, i) : decoded;
    const supplied = i >= 0 ? decoded.slice(i + 1) : '';
    return safeEqual(user, process.env.DASHBOARD_USER ?? 'operator') && safeEqual(supplied, expected);
  } catch {
    return false;
  }
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function money(cents: number): string {
  return `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pct(numerator: number, denominator: number): string {
  return denominator ? `${((100 * numerator) / denominator).toFixed(1)}%` : '—';
}
function dollarsToCents(v: string, fallback: number): number {
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : fallback;
}
function intValue(v: string, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
}
function titleCase(s: string): string {
  return s.replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function dateText(v: unknown): string {
  const d = new Date(String(v ?? ''));
  return Number.isNaN(d.getTime()) ? String(v ?? '—') : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function carrierName(id: string, contracts: CarrierContract[]): string {
  return contracts.find((c) => c.carrier === id)?.name ?? titleCase(id);
}

type World = {
  stats: LedgerStats;
  contracts: CarrierContract[];
  shipments: Shipment[];
  visibleShipments: Shipment[];
  claims: CarrierClaim[];
  findings: Finding[];
  settings: AgentSettings;
  bundleStats: BundleStat[];
  queue: any[];
  suppressed: Set<string>;
  trials: any[];
};

async function loadWorld(): Promise<World> {
  const [stats, contracts, shipments, claims, settings, bundleStats, queue, suppressed, trials] = await Promise.all([
    ledger.ledgerStats(),
    ledger.listContracts(),
    ledger.listShipments(),
    ledger.listClaims(),
    loadSettings(SCOPE),
    db.bundleStats(SCOPE),
    db.openQueue(SCOPE),
    db.suppressed(SCOPE),
    db.claimTrials(SCOPE),
  ]);
  await syncClaimOutcomes(SCOPE, claims);
  const visibleShipments = shipments.filter((s) => s.invoiceDay <= stats.worldDay);
  return {
    stats,
    contracts,
    shipments,
    visibleShipments,
    claims,
    findings: auditShipments(visibleShipments, contracts),
    settings,
    bundleStats: await db.bundleStats(SCOPE),
    queue,
    suppressed,
    trials,
  };
}

function sameClaims(f: Finding, claims: CarrierClaim[]): CarrierClaim[] {
  return claims.filter((c) => c.shipmentId === f.shipment.id && c.chargeId === f.charge.id && c.category === f.category);
}

type FindingState = { key: string; label: string; tone: string; claim?: CarrierClaim; parent?: CarrierClaim };

function findingState(f: Finding, w: World): FindingState {
  const same = sameClaims(f, w.claims);
  const credited = same.find((c) => c.status === 'credited');
  if (credited) return { key: 'credited', label: 'Credit posted', tone: 'green', claim: credited };
  const approved = same.find((c) => c.status === 'approved');
  if (approved) return { key: 'approved', label: 'Approved — waiting for credit', tone: 'amber', claim: approved };
  const submitted = same.find((c) => c.status === 'submitted');
  if (submitted) return { key: 'submitted', label: submitted.stage === 'appeal' ? 'Appeal with carrier' : 'With carrier', tone: 'blue', claim: submitted };
  const appealDenied = same.find((c) => c.stage === 'appeal' && c.status === 'denied');
  if (appealDenied) return { key: 'appeal_denied', label: 'Appeal denied — person owns it', tone: 'red', claim: appealDenied };
  const denied = same.find((c) => c.stage === 'initial' && c.status === 'denied');
  if (denied) return { key: 'appeal_ready', label: 'Denied — appeal ready', tone: 'purple', claim: denied, parent: denied };
  if (w.queue.some((q) => q.shipment_id === f.shipment.id && q.charge_id === f.charge.id && q.kind === 'claim_review')) {
    return { key: 'queued', label: 'Needs your decision', tone: 'amber' };
  }
  if (w.suppressed.has(f.shipment.id)) return { key: 'held', label: 'Held by you', tone: 'gray' };
  if (w.stats.worldDay > f.deadlineDay) return { key: 'expired', label: 'Deadline passed', tone: 'red' };
  if (f.shipment.contractAmbiguous) return { key: 'ambiguous', label: 'Check side agreement', tone: 'amber' };
  if (f.amountCents > w.settings.humanAboveCents) return { key: 'large', label: 'Large — needs approval', tone: 'amber' };
  if (f.amountCents < w.settings.minClaimCents || f.amountCents <= w.settings.toleranceCents) return { key: 'small', label: 'Below claim threshold', tone: 'gray' };
  return { key: 'open', label: 'Ready to claim', tone: 'green' };
}

function badge(label: string, tone = 'gray'): string {
  return `<span class="badge ${esc(tone)}">${esc(label)}</span>`;
}
function statusTone(status: string): string {
  return status === 'credited' ? 'green' : status === 'approved' ? 'amber' : status === 'denied' ? 'red' : 'blue';
}

const CSS = `
:root{--ink:#18202a;--muted:#667085;--faint:#98a2b3;--line:#dbe2ea;--bg:#eef2f6;--card:#fff;--navy:#102938;--navy2:#173d57;--teal:#0f766e;--teal2:#ccfbf1;--amber:#b45309;--amberbg:#fef3c7;--red:#b42318;--redbg:#fee4e2;--green:#067647;--greenbg:#dcfae6;--blue:#175cd3;--bluebg:#e0eaff;--purple:#6941c6;--purplebg:#ebe9fe;--graybg:#eaecf0;--radius:18px;--shadow:0 14px 35px rgba(16,41,56,.09)}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 15% -10%,#d7f5ee 0,transparent 34rem),radial-gradient(circle at 95% 0,#dbeafe 0,transparent 30rem),var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.5}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}.topbar{position:sticky;top:0;z-index:20;background:rgba(16,41,56,.96);backdrop-filter:blur(10px);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.16)}.topbar-in{max-width:1420px;margin:auto;padding:14px 22px;display:flex;align-items:center;gap:22px}.brand{display:flex;align-items:center;gap:11px;color:#fff;font-size:21px;font-weight:850;letter-spacing:-.03em;white-space:nowrap}.brand:hover{text-decoration:none}.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,#2dd4bf,#38bdf8);display:grid;place-items:center;color:#07332f;font-size:19px;box-shadow:inset 0 1px 0 rgba(255,255,255,.55)}nav{display:flex;gap:4px;overflow:auto;scrollbar-width:none}nav::-webkit-scrollbar{display:none}nav a{color:#cbd5e1;padding:9px 11px;border-radius:999px;font-weight:650;white-space:nowrap}nav a:hover{color:#fff;text-decoration:none;background:rgba(255,255,255,.08)}nav a.active{background:#fff;color:var(--navy)}.countdot{display:inline-grid;place-items:center;min-width:21px;height:21px;padding:0 5px;border-radius:99px;background:#f59e0b;color:#111827;font-size:12px;margin-left:4px}.worldchip{margin-left:auto;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.15);padding:8px 11px;border-radius:999px;color:#dbeafe;white-space:nowrap;font-size:13px}
.page{max-width:1420px;margin:0 auto;padding:28px 22px 56px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;margin:4px 0 22px}.hero h1{font-size:clamp(30px,4vw,48px);line-height:1.03;letter-spacing:-.045em;margin:0 0 8px}.hero p{color:var(--muted);max-width:760px;margin:0;font-size:16px}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:12px;font-weight:800;color:var(--teal);margin-bottom:8px}.flash{border-radius:14px;padding:13px 16px;margin:0 0 18px;border:1px solid #a6f4c5;background:#ecfdf3;color:#05603a}.flash.error{border-color:#fecdca;background:#fffbfa;color:#912018}.grid{display:grid;gap:18px}.grid.kpis{grid-template-columns:repeat(6,1fr)}.grid.two{grid-template-columns:repeat(2,1fr)}.grid.three{grid-template-columns:repeat(3,1fr)}.grid.four{grid-template-columns:repeat(4,1fr)}.card{background:var(--card);border:1px solid rgba(203,213,225,.85);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px}.card.flat{box-shadow:none}.card h2,.card h3{letter-spacing:-.025em;margin:0 0 8px}.card h2{font-size:22px}.card h3{font-size:17px}.muted{color:var(--muted)}.small{font-size:13px}.kpi .label{color:var(--muted);font-size:13px;font-weight:750;text-transform:uppercase;letter-spacing:.07em}.kpi .value{font-size:29px;line-height:1.1;font-weight:880;letter-spacing:-.04em;margin:7px 0 4px}.kpi .sub{color:var(--muted);font-size:13px}.accent{border-top:5px solid var(--teal)}.warn{border-top-color:#f59e0b}.danger{border-top-color:#f04438}.bluea{border-top-color:#2e90fa}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid #cbd5e1;background:#fff;color:var(--ink);border-radius:999px;padding:10px 15px;font-weight:760;cursor:pointer;font:inherit;font-size:14px;box-shadow:0 2px 6px rgba(16,24,40,.05)}.btn:hover{transform:translateY(-1px);text-decoration:none}.btn.primary{background:var(--teal);border-color:var(--teal);color:#fff}.btn.dark{background:var(--navy);border-color:var(--navy);color:#fff}.btn.danger{background:#fff;color:var(--red);border-color:#fecdca}.btn.smallbtn{padding:7px 10px;font-size:13px}.btn:disabled{opacity:.55;transform:none}.actions{display:flex;gap:9px;flex-wrap:wrap;align-items:center}.runpanel{background:linear-gradient(135deg,#102938,#155e55);color:#fff}.runpanel .muted{color:#c4d8e3}.runpanel .btn.primary{background:#2dd4bf;color:#07332f;border-color:#2dd4bf}.switchline{display:flex;gap:9px;align-items:center;margin-top:10px;color:#dbeafe}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:780;background:var(--graybg);color:#475467;white-space:nowrap}.badge.green{background:var(--greenbg);color:var(--green)}.badge.amber{background:var(--amberbg);color:var(--amber)}.badge.red{background:var(--redbg);color:var(--red)}.badge.blue{background:var(--bluebg);color:var(--blue)}.badge.purple{background:var(--purplebg);color:var(--purple)}
.tablewrap{overflow:auto;border:1px solid var(--line);border-radius:15px;background:#fff}table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:12px 13px;text-align:left;vertical-align:top;border-bottom:1px solid #edf1f5}th{background:#f8fafc;color:#475467;font-size:12px;text-transform:uppercase;letter-spacing:.07em}tr:last-child td{border-bottom:0}.right{text-align:right}.money{font-variant-numeric:tabular-nums;font-weight:780}.bar{height:9px;background:#edf2f7;border-radius:99px;overflow:hidden}.bar>i{display:block;height:100%;background:linear-gradient(90deg,#14b8a6,#38bdf8);border-radius:99px}.pipeline{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.step{position:relative;background:#f8fafc;border:1px solid var(--line);border-radius:15px;padding:14px}.step b{display:block;font-size:22px}.step span{color:var(--muted);font-size:13px}.step:not(:last-child):after{content:"›";position:absolute;right:-8px;top:38%;z-index:2;background:#fff;border:1px solid var(--line);width:16px;height:16px;border-radius:50%;display:grid;place-items:center;color:var(--muted)}
.filters{display:flex;gap:9px;flex-wrap:wrap;align-items:end;margin-bottom:16px}.field{display:flex;flex-direction:column;gap:5px}.field>label,.field>span:not(.help){font-size:12px;font-weight:800;color:#475467;text-transform:uppercase;letter-spacing:.06em}.field>span.help{font-size:13px;font-weight:400;color:var(--muted);text-transform:none;letter-spacing:0;line-height:1.45}input,select,textarea{border:1px solid #cbd5e1;border-radius:11px;padding:10px 11px;font:inherit;background:#fff;color:var(--ink);min-height:42px}textarea{width:100%;min-height:110px;resize:vertical}input:focus,select:focus,textarea:focus{outline:3px solid #99f6e4;border-color:var(--teal)}input[type=checkbox]{min-height:auto;width:18px;height:18px;accent-color:var(--teal)}input[type=range]{padding:0}.checkrow{display:flex;gap:9px;align-items:flex-start;padding:9px 0}.checkrow input{margin-top:2px}.checkgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 16px}.help{font-size:13px;color:var(--muted);text-transform:none;letter-spacing:0}.divider{height:1px;background:var(--line);margin:18px 0}.sectionhead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}.kv{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.kv div{background:#f8fafc;border:1px solid #e6edf3;border-radius:13px;padding:11px}.kv dt{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em;font-weight:800}.kv dd{margin:3px 0 0;font-weight:760}.finding{border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:13px;background:#fff}.finding-head{display:flex;justify-content:space-between;gap:13px;align-items:flex-start}.finding h3{margin:0}.timeline{border-left:3px solid #ccfbf1;padding-left:17px;margin-left:6px}.event{position:relative;padding:0 0 16px}.event:before{content:"";position:absolute;left:-24px;top:5px;width:9px;height:9px;border-radius:50%;background:var(--teal);box-shadow:0 0 0 4px #f0fdfa}.empty{padding:26px;text-align:center;color:var(--muted)}details{border:1px solid var(--line);border-radius:14px;padding:13px 15px;margin:10px 0;background:#fbfcfe}summary{font-weight:800;cursor:pointer}pre{white-space:pre-wrap;word-break:break-word;background:#0b1d2a;color:#dbeafe;border-radius:13px;padding:14px;overflow:auto}.callout{border-radius:15px;padding:14px 16px;background:#f0fdfa;border:1px solid #99f6e4}.callout.warnbox{background:#fffbeb;border-color:#fde68a}.callout.redbox{background:#fffbfa;border-color:#fecdca}.pilltabs{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 18px}.pilltabs a{padding:8px 12px;border:1px solid var(--line);background:#fff;border-radius:999px;color:var(--ink);font-weight:720}.pilltabs a.active{background:var(--navy);color:#fff}.fab-note{font-size:12px;color:var(--faint)}.footer{color:var(--muted);text-align:center;padding:30px 0 0;font-size:13px}.sticky-actions{position:sticky;bottom:14px;z-index:12;background:#fff;border:1px solid #c7d6df;border-radius:16px;box-shadow:0 18px 42px rgba(16,41,56,.2);padding:13px;display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:18px}.presetgrid{display:flex;gap:8px;flex-wrap:wrap}.preset{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;background:#fff;padding:8px 11px;cursor:pointer;font-weight:750}.preset:hover{border-color:var(--teal);color:var(--teal)}.btn svg,.preset svg,.logo svg{width:16px;height:16px;flex:0 0 auto}.logo svg{width:21px;height:21px}.empty h2 svg{width:21px;height:21px;vertical-align:-4px;margin-right:6px;color:var(--teal)}
@media(max-width:1100px){.grid.kpis{grid-template-columns:repeat(3,1fr)}.grid.four{grid-template-columns:repeat(2,1fr)}.grid.three{grid-template-columns:repeat(2,1fr)}.worldchip{display:none}}
@media(max-width:760px){.topbar-in{padding:11px 13px;gap:11px}.brand{font-size:18px}.page{padding:20px 13px 44px}.hero{display:block}.grid.kpis,.grid.two,.grid.three,.grid.four,.pipeline,.kv,.checkgrid{grid-template-columns:1fr}.step:not(:last-child):after{display:none}.card{padding:16px}.finding-head{display:block}.sticky-actions{display:block}.sticky-actions .actions{margin-top:10px}}
`;

function icon(name: 'play' | 'pause' | 'fast' | 'gear' | 'shield' | 'scale' | 'alert' | 'check' | 'return'): string {
  const paths: Record<string, string> = {
    play: '<polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none"/>',
    fast: '<polygon points="3 5 12 12 3 19 3 5" fill="currentColor" stroke="none"/><polygon points="12 5 21 12 12 19 12 5" fill="currentColor" stroke="none"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    scale: '<path d="M12 3v18"/><path d="M7 21h10"/><path d="M5 7h14"/><path d="m6 7-3 6a3.5 3.5 0 0 0 6 0L6 7z"/><path d="m18 7-3 6a3.5 3.5 0 0 0 6 0l-3-6z"/><path d="M12 7l-6 0M12 7l6 0"/>',
    alert: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m8 12.5 2.7 2.7L16.5 9"/>',
    return: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5A5.5 5.5 0 0 1 14.5 20H11"/>',
  };
  return `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

function layout(title: string, active: string, body: string, opts: { flash?: string; error?: string; world?: World | null } = {}): string {
  const queueCount = opts.world?.queue.length ?? 0;
  const nav = [
    ['/', 'home', 'Home'],
    ['/shipments', 'shipments', 'Shipments'],
    ['/claims', 'claims', 'Claims'],
    ['/queue', 'queue', `Needs you${queueCount ? `<span class="countdot">${queueCount}</span>` : ''}`],
    ['/controls', 'controls', 'Controls'],
    ['/learning', 'learning', 'What works'],
    ['/activity', 'activity', 'Activity'],
    ['/guide', 'guide', 'Guide'],
  ].map(([href, key, label]) => `<a class="${active === key ? 'active' : ''}" href="${href}">${label}</a>`).join('');
  const chip = opts.world ? `Carrier world day ${opts.world.stats.worldDay} · ${opts.world.visibleShipments.length} billed shipments visible` : 'Carrier system status unavailable';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Haulback</title><style>${CSS}</style></head>
<body><header class="topbar"><div class="topbar-in"><a class="brand" href="/"><span class="logo">${icon('return')}</span><span>Haulback</span></a><nav>${nav}</nav><span class="worldchip">${esc(chip)}</span></div></header>
<main class="page">${opts.flash ? `<div class="flash">${esc(opts.flash)}</div>` : ''}${opts.error ? `<div class="flash error">${esc(opts.error)}</div>` : ''}${body}<div class="footer">Haulback works against a fictional Go carrier stand-in in this deployment. Real carrier credentials would replace only the carrier connection; the audit, safety gate, learning, and reconciliation stay the same.</div></main></body></html>`;
}

function hero(eyebrow: string, title: string, text: string, actions = ''): string {
  return `<section class="hero"><div><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p>${esc(text)}</p></div><div class="actions">${actions}</div></section>`;
}

function findingRows(findings: Finding[], w: World, limit = 12): string {
  if (!findings.length) return '<div class="empty">No supported findings match this view.</div>';
  return `<div class="tablewrap"><table><thead><tr><th>Shipment</th><th>What looks wrong</th><th class="right">Supported amount</th><th>Deadline</th><th>Status</th><th></th></tr></thead><tbody>${findings.slice(0, limit).map((f) => {
    const st = findingState(f, w);
    const days = f.deadlineDay - w.stats.worldDay;
    return `<tr><td><a href="/shipments/${esc(f.shipment.id)}"><b>${esc(f.shipment.tracking)}</b></a><br><span class="muted small">${esc(carrierName(f.shipment.carrier, w.contracts))} · ${esc(f.shipment.origin)} → ${esc(f.shipment.destination)}</span></td>
    <td><b>${esc(CATEGORY_LABEL[f.category])}</b><br><span class="muted small">${esc(f.explanation)}</span></td>
    <td class="right money">${money(f.amountCents)}</td><td>Day ${f.deadlineDay}<br>${badge(days < 0 ? `${-days} days late` : days <= 3 ? `${days} days left` : `${days} days left`, days < 0 ? 'red' : days <= 3 ? 'amber' : 'blue')}</td>
    <td>${badge(st.label, st.tone)}</td><td><a class="btn smallbtn" href="/shipments/${esc(f.shipment.id)}#finding-${esc(f.charge.id)}-${esc(f.category)}">Open case</a></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function runPanel(w: World): string {
  const schedule = scheduleStatus(w.settings);
  return `<section class="card runpanel"><div class="sectionhead"><div><h2>${w.settings.enabled ? 'Haulback is ready to work' : 'Haulback is paused'}</h2><p class="muted" style="margin:0">A sweep checks every visible carrier bill, files safe supported claims, appeals a denied claim once, and checks whether approved money actually posted.</p></div>${badge(w.settings.enabled ? 'Agent on' : 'Agent paused', w.settings.enabled ? 'green' : 'amber')}</div>
  <form class="actions" method="post" action="/run"><button class="btn primary" type="submit">${icon('play')} Run Haulback now</button><label class="switchline" style="margin:0"><input type="checkbox" name="advance" value="1"> After running, move the pretend carrier clock forward 1 day</label></form>
  <div class="actions" style="margin-top:12px">${w.settings.enabled ? `<form method="post" action="/pause"><button class="btn" type="submit">${icon('pause')} Pause agent</button></form>` : `<form method="post" action="/resume"><button class="btn" type="submit">${icon('play')} Resume agent</button></form>`}<form method="post" action="/advance-day"><button class="btn" type="submit">${icon('fast')} Carrier clock +1 day</button></form><a class="btn" href="/controls">${icon('gear')} Controls</a></div>
  <p class="small" style="color:#bae6fd;margin-bottom:0">Schedule clock: ${esc(schedule.localTime)} in ${esc(w.settings.timezone)} — ${esc(schedule.reason)}. “Run now” safely ignores the schedule once; it never ignores claim law.</p></section>`;
}

async function homePage(w: World, flash = '', error = ''): Promise<string> {
  const billed = w.visibleShipments.reduce((n, s) => n + s.charges.reduce((m, c) => m + c.totalCents, 0), 0);
  const expected = w.visibleShipments.reduce((n, s) => {
    const c = w.contracts.find((x) => x.carrier === s.carrier);
    return n + (c ? expectedFor(s, c).totalCents : 0);
  }, 0);
  const ready = sortFindings(w.findings.filter((f) => ['open', 'appeal_ready'].includes(findingState(f, w).key)), w.bundleStats, w.stats.worldDay);
  const dueSoon = ready.filter((f) => f.deadlineDay - w.stats.worldDay <= 3 && f.deadlineDay >= w.stats.worldDay);
  const readyCents = ready.reduce((n, f) => n + f.amountCents, 0);
  const decided = w.claims.filter((c) => c.status !== 'submitted');
  const won = w.claims.filter((c) => ['approved', 'credited'].includes(c.status)).length;
  const submitted = w.claims.filter((c) => c.status === 'submitted').length;
  const recent = await db.recentDecisions(SCOPE, 8);
  const carriers = CARRIERS.map((carrier) => {
    const shipments = w.visibleShipments.filter((s) => s.carrier === carrier);
    const findings = w.findings.filter((f) => f.shipment.carrier === carrier);
    const claims = w.claims.filter((c) => shipments.some((s) => s.id === c.shipmentId));
    return { carrier, billed: shipments.reduce((n, s) => n + s.charges.reduce((m, c) => m + c.totalCents, 0), 0), findings: findings.reduce((n, f) => n + f.amountCents, 0), claims: claims.length, credited: claims.filter((c) => c.status === 'credited').reduce((n, c) => n + c.amountCents, 0) };
  });
  const categories = CLAIM_CATEGORIES.map((category) => ({ category, cents: w.findings.filter((f) => f.category === category).reduce((n, f) => n + f.amountCents, 0), count: w.findings.filter((f) => f.category === category).length })).sort((a, b) => b.cents - a.cents);
  const maxCat = Math.max(1, ...categories.map((x) => x.cents));

  const nextAction = w.queue.length
    ? `<div class="callout warnbox"><b>Start with “Needs you”.</b> There ${w.queue.length === 1 ? 'is 1 case' : `are ${w.queue.length} cases`} where a person must decide before money can move. <a href="/queue">Review them →</a></div>`
    : dueSoon.length
      ? `<div class="callout warnbox"><b>Deadline first.</b> ${dueSoon.length} supported claim${dueSoon.length === 1 ? '' : 's'} expire within 3 carrier days. Run Haulback now so safe claims are filed before the window closes.</div>`
      : w.stats.approvedUncreditedCents > 0
        ? `<div class="callout"><b>Money was promised but has not posted.</b> ${money(w.stats.approvedUncreditedCents)} is approved-not-credited. Haulback chases it after the grace you choose in Controls.</div>`
        : `<div class="callout"><b>The desk is clear.</b> Run a sweep after new carrier invoices arrive, or open a shipment to inspect the exact recalculation.</div>`;

  const body = `${hero('Carrier money recovery', 'Find the carrier’s mistake before the deadline eats it.', 'Haulback re-prices every shipment from the signed contract, files only claims the evidence supports, learns which proof each carrier accepts, and keeps chasing until the credit is really on the bill.')}
  <div class="grid two" style="margin-bottom:18px"><div>${runPanel(w)}</div><section class="card"><div class="eyebrow">What should you do now?</div><h2>Your next best move</h2>${nextAction}<div class="divider"></div><div class="pipeline">
    <div class="step"><b>${w.visibleShipments.length}</b><span>Bills checked</span></div><div class="step"><b>${w.findings.length}</b><span>Supported findings</span></div><div class="step"><b>${submitted}</b><span>With carrier now</span></div><div class="step"><b>${won}</b><span>Claims won</span></div><div class="step"><b>${money(w.stats.creditedCents)}</b><span>Credits posted</span></div>
  </div><p class="help">An “approved” claim is only a promise. Haulback does not count the job finished until status becomes <b>credited</b>.</p></section></div>
  <section class="grid kpis" style="margin-bottom:18px">
    <div class="card kpi accent"><div class="label">Carrier bills checked</div><div class="value">${money(billed)}</div><div class="sub">${w.visibleShipments.length} shipments · contract price ${money(expected)}</div></div>
    <div class="card kpi accent warn"><div class="label">Ready to recover</div><div class="value">${money(readyCents)}</div><div class="sub">${ready.length} safe/open findings, deadline-first</div></div>
    <div class="card kpi accent bluea"><div class="label">Credits posted</div><div class="value">${money(w.stats.creditedCents)}</div><div class="sub">Real money back on the carrier bill</div></div>
    <div class="card kpi accent warn"><div class="label">Promised, not posted</div><div class="value">${money(w.stats.approvedUncreditedCents)}</div><div class="sub">Approved claims still missing a credit</div></div>
    <div class="card kpi accent"><div class="label">Claim win rate</div><div class="value">${pct(won, decided.length)}</div><div class="sub">${won} won of ${decided.length} decided claims</div></div>
    <div class="card kpi accent danger"><div class="label">Needs a person</div><div class="value">${w.queue.length}</div><div class="sub">Ambiguous, large, blocked, or missing-credit cases</div></div>
  </section>
  <section class="card" style="margin-bottom:18px"><div class="sectionhead"><div><div class="eyebrow">Deadline rescue list</div><h2>Money to save first</h2><p class="muted" style="margin:0">Haulback sorts by expiry first, then by expected net value after proof-pack cost.</p></div><a class="btn" href="/shipments?view=findings">See all findings</a></div>${findingRows(ready, w, 10)}</section>
  <div class="grid two"><section class="card"><h2>Where the mistakes are</h2>${categories.filter((x) => x.cents).map((x) => `<div style="margin:13px 0"><div class="sectionhead" style="margin:0 0 5px"><span><b>${esc(CATEGORY_LABEL[x.category])}</b> <span class="muted small">· ${x.count} findings</span></span><span class="money">${money(x.cents)}</span></div><div class="bar"><i style="width:${(100 * x.cents / maxCat).toFixed(1)}%"></i></div></div>`).join('') || '<p class="muted">No mistakes found yet.</p>'}</section>
  <section class="card"><h2>Carrier scorecards</h2>${carriers.map((c) => `<div class="divider"></div><div class="sectionhead"><div><b>${esc(carrierName(c.carrier, w.contracts))}</b><div class="muted small">Billed ${money(c.billed)} · supported findings ${money(c.findings)} · ${c.claims} claims</div></div><div class="right"><span class="muted small">posted</span><br><span class="money">${money(c.credited)}</span></div></div>`).join('')}</section></div>
  <section class="card" style="margin-top:18px"><div class="sectionhead"><div><h2>Latest agent decisions</h2><p class="muted" style="margin:0">Every claim, block, appeal, and credit chase leaves a reason.</p></div><a class="btn" href="/activity">Full activity</a></div>${recent.length ? `<div class="timeline">${recent.map((d) => `<div class="event"><b>${esc(titleCase(String(d.action)))}</b> ${badge(String(d.outcome), statusTone(String(d.outcome)))} <span class="muted small">world day ${esc(d.world_day)} · ${dateText(d.at)}</span><br><a href="/shipments/${esc(d.shipment_id)}">${esc(d.shipment_id)}</a> · ${esc(d.why)}</div>`).join('')}</div>` : '<div class="empty">No decisions yet. Run Haulback once.</div>'}</section>`;
  return layout('Home', 'home', body, { flash, error, world: w });
}

function shipmentSummary(s: Shipment, w: World): { billed: number; expected: number; findings: Finding[] } {
  const contract = w.contracts.find((c) => c.carrier === s.carrier);
  return {
    billed: s.charges.reduce((n, c) => n + c.totalCents, 0),
    expected: contract ? expectedFor(s, contract).totalCents : 0,
    findings: w.findings.filter((f) => f.shipment.id === s.id),
  };
}

function shipmentsPage(w: World, url: URL, flash = '', error = ''): string {
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const carrier = url.searchParams.get('carrier') ?? '';
  const view = url.searchParams.get('view') ?? 'all';
  let rows = w.shipments.filter((s) => !carrier || s.carrier === carrier);
  if (q) rows = rows.filter((s) => [s.id, s.tracking, s.customerRef, s.origin, s.destination, s.service, s.carrier].join(' ').toLowerCase().includes(q));
  rows = rows.filter((s) => {
    const sum = shipmentSummary(s, w);
    if (view === 'findings') return sum.findings.length > 0;
    if (view === 'clean') return s.invoiceDay <= w.stats.worldDay && sum.findings.length === 0;
    if (view === 'claimed') return w.claims.some((c) => c.shipmentId === s.id);
    if (view === 'ambiguous') return s.contractAmbiguous;
    if (view === 'future') return s.invoiceDay > w.stats.worldDay;
    return true;
  });
  const sort = url.searchParams.get('sort') ?? 'deadline';
  rows.sort((a, b) => {
    const af = shipmentSummary(a, w).findings;
    const bf = shipmentSummary(b, w).findings;
    if (sort === 'amount') return bf.reduce((n, f) => n + f.amountCents, 0) - af.reduce((n, f) => n + f.amountCents, 0);
    if (sort === 'newest') return b.invoiceDay - a.invoiceDay;
    return Math.min(9999, ...af.map((f) => f.deadlineDay)) - Math.min(9999, ...bf.map((f) => f.deadlineDay));
  });

  const body = `${hero('Shipment case files', 'Every parcel, re-priced line by line.', 'Open any shipment to see what the carrier charged, what the contract says it should have charged, and exactly which proof supports a claim.', '<a class="btn primary" href="#add-shipment">+ Add test shipment</a>')}
  <form class="filters card flat" method="get" action="/shipments"><div class="field" style="flex:2;min-width:230px"><label for="q">Search</label><input id="q" name="q" value="${esc(q)}" placeholder="Tracking, customer, city, service…"></div>
  <div class="field"><label for="carrier">Carrier</label><select id="carrier" name="carrier"><option value="">All carriers</option>${CARRIERS.map((c) => `<option value="${c}" ${carrier === c ? 'selected' : ''}>${esc(carrierName(c, w.contracts))}</option>`).join('')}</select></div>
  <div class="field"><label for="view">Show</label><select id="view" name="view">${[['all', 'All shipments'], ['findings', 'Has money to recover'], ['claimed', 'Already claimed'], ['clean', 'Clean bills'], ['ambiguous', 'Side-agreement warning'], ['future', 'Invoice not visible yet']].map(([v, label]) => `<option value="${v}" ${view === v ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
  <div class="field"><label for="sort">Sort</label><select id="sort" name="sort"><option value="deadline">Deadline first</option><option value="amount" ${sort === 'amount' ? 'selected' : ''}>Largest recovery</option><option value="newest" ${sort === 'newest' ? 'selected' : ''}>Newest invoice</option></select></div><button class="btn dark">Filter</button><a class="btn" href="/shipments">Reset</a></form>
  <p class="muted">Showing <b>${rows.length}</b> of ${w.shipments.length} shipments. Future invoices exist in the pretend world but Haulback does not act until their invoice day arrives.</p>
  <div class="tablewrap"><table><thead><tr><th>Shipment</th><th>Route / service</th><th class="right">Carrier billed</th><th class="right">Contract price</th><th class="right">Possible recovery</th><th>Case state</th><th></th></tr></thead><tbody>${rows.slice(0, 150).map((s) => {
    const sum = shipmentSummary(s, w);
    const first = sum.findings[0];
    const state = s.invoiceDay > w.stats.worldDay ? badge('Invoice not visible yet', 'gray') : sum.findings.length ? badge(findingState(first, w).label, findingState(first, w).tone) : badge('Clean', 'green');
    return `<tr><td><a href="/shipments/${esc(s.id)}"><b>${esc(s.tracking)}</b></a><br><span class="muted small">${esc(s.customerRef)} · invoice day ${s.invoiceDay}</span></td><td>${esc(carrierName(s.carrier, w.contracts))}<br><span class="muted small">${esc(s.origin)} → ${esc(s.destination)} · ${esc(titleCase(s.service))}</span></td><td class="right money">${money(sum.billed)}</td><td class="right money">${money(sum.expected)}</td><td class="right money">${sum.findings.length ? money(sum.findings.reduce((n, f) => n + f.amountCents, 0)) : '—'}</td><td>${state}${s.contractAmbiguous ? '<br>' + badge('Side agreement?', 'amber') : ''}</td><td><a class="btn smallbtn" href="/shipments/${esc(s.id)}">Open</a></td></tr>`;
  }).join('')}</tbody></table></div>
  <section class="card" id="add-shipment" style="margin-top:20px"><div class="eyebrow">Try it yourself</div><h2>Add a test shipment</h2><p class="muted">This writes a new fictional shipment into the Go carrier world. Pick a billing story, then run Haulback and watch the case move.</p>
  <form method="post" action="/shipments"><div class="grid three">
    <div class="field"><label>What story?</label><select name="scenario"><option value="clean">Clean bill — no mistake</option><option value="late">Guaranteed delivery arrives late</option><option value="rate">Carrier uses a heavier weight</option><option value="duplicate">Carrier bills twice</option><option value="fee">Carrier adds a wrong home-delivery fee</option><option value="not_tendered">Label billed but never shipped</option><option value="ambiguous">Possible side agreement — must go to a person</option></select></div>
    <div class="field"><label>Carrier</label><select name="carrier">${CARRIERS.map((c) => `<option value="${c}">${esc(carrierName(c, w.contracts))}</option>`).join('')}</select></div>
    <div class="field"><label>Service</label><select name="service"><option value="express">Express (guaranteed)</option><option value="priority">Priority (guaranteed)</option><option value="ground">Ground (no guarantee)</option></select></div>
    <div class="field"><label>Customer / order</label><input name="customerRef" value="Demo order"></div><div class="field"><label>From</label><input name="origin" value="Austin, TX"></div><div class="field"><label>To</label><input name="destination" value="Portland, OR"></div>
    <div class="field"><label>Zone (2–8)</label><input type="number" min="2" max="8" name="zone" value="5"></div><div class="field"><label>Actual weight (grams)</label><input type="number" min="100" step="50" name="weightGrams" value="1200"></div><div class="field"><label>Box size L × W × H (cm)</label><input name="dims" value="30 × 22 × 10"></div>
  </div><div class="actions" style="margin-top:14px"><button class="btn primary">Create shipment</button><span class="help">It will be invoiced on the current carrier world day (${w.stats.worldDay}).</span></div></form></section>`;
  return layout('Shipments', 'shipments', body, { flash, error, world: w });
}

function messageForBundle(f: Finding, bundle: Bundle, settings: AgentSettings): string {
  return renderTemplate(settings.templates[bundle], {
    carrier: f.shipment.carrier,
    carrierName: f.contract.name,
    tracking: f.shipment.tracking,
    invoice: f.charge.invoiceId,
    amount: money(f.amountCents),
    explanation: f.explanation,
    category: f.category,
    deadlineDay: f.deadlineDay,
  });
}

function claimForm(f: Finding, w: World, actionLabel: string): string {
  const st = findingState(f, w);
  const defaultBundle = st.parent
    ? chooseBundle(w.bundleStats, f.shipment.carrier, f.category, f.amountCents, 0, w.settings.enabledBundles)
    : chooseBundle(w.bundleStats, f.shipment.carrier, f.category, f.amountCents, w.settings.explorationPct / 100, w.settings.enabledBundles);
  const id = `${f.charge.id}-${f.category}`.replace(/[^A-Za-z0-9_-]/g, '-');
  return `<form method="post" action="/shipments/${esc(f.shipment.id)}/claim" style="margin-top:13px">
  <input type="hidden" name="chargeId" value="${esc(f.charge.id)}"><input type="hidden" name="category" value="${esc(f.category)}">
  <div class="grid two"><div class="field"><label for="bundle-${esc(id)}">Proof pack</label><select id="bundle-${esc(id)}" name="bundle" onchange="document.getElementById('msg-${esc(id)}').value=this.selectedOptions[0].dataset.message">${BUNDLES.map((b) => `<option value="${b}" ${b === defaultBundle ? 'selected' : ''} ${w.settings.enabledBundles.includes(b) ? '' : 'disabled'} data-message="${esc(messageForBundle(f, b, w.settings))}">${esc(BUNDLE_LABEL[b])} · prep ${money(BUNDLE_COST_CENTS[b])}${w.settings.enabledBundles.includes(b) ? '' : ' (off)'}</option>`).join('')}</select><span class="help">Haulback learns which pack this carrier accepts for this kind of mistake.</span></div>
  <div class="field"><label for="msg-${esc(id)}">Message to carrier</label><textarea id="msg-${esc(id)}" name="message">${esc(messageForBundle(f, defaultBundle, w.settings))}</textarea><span class="help">You may edit words. You cannot raise the ${money(f.amountCents)} code-supported amount from this screen.</span></div></div>
  <div class="actions" style="margin-top:10px"><button class="btn primary" type="submit">${esc(actionLabel)}</button><span class="help">The safety gate checks the deadline, duplicate claims, evidence, and banned language again before anything is sent.</span></div></form>`;
}

async function shipmentPage(w: World, id: string, flash = '', error = ''): Promise<string> {
  const s = w.shipments.find((x) => x.id === id);
  if (!s) return layout('Not found', 'shipments', `${hero('Shipment', 'That shipment does not exist.', 'It may have been reset in the pretend carrier world.')}<a class="btn" href="/shipments">Back to shipments</a>`, { error: 'Shipment not found', world: w });
  const contract = w.contracts.find((c) => c.carrier === s.carrier)!;
  const expected = expectedFor(s, contract);
  const findings = auditShipment(s, contract);
  const claims = w.claims.filter((c) => c.shipmentId === s.id);
  const decisions = await db.decisionsFor(SCOPE, s.id);
  const events = await ledger.listEvents(s.id).catch(() => []);
  const billed = s.charges.reduce((n, c) => n + c.totalCents, 0);
  const findingHtml = s.invoiceDay > w.stats.worldDay
    ? `<div class="callout warnbox"><b>This invoice is not visible yet in carrier time.</b> Haulback will audit it when world day ${s.invoiceDay} arrives. Showing the future record here is only for inspection.</div>`
    : findings.length ? findings.map((f) => {
      const st = findingState(f, w);
      const canFile = st.key === 'open' || st.key === 'large' || st.key === 'ambiguous' || st.key === 'small' || st.key === 'queued' || st.key === 'held' || st.key === 'expired';
      const canAppeal = st.key === 'appeal_ready';
      return `<article class="finding" id="finding-${esc(f.charge.id)}-${esc(f.category)}"><div class="finding-head"><div><h3>${esc(CATEGORY_LABEL[f.category])}</h3><p class="muted" style="margin:3px 0">${esc(f.explanation)}</p><span class="small muted">Invoice ${esc(f.charge.invoiceId)} · charge ${esc(f.charge.id)} · deadline world day ${f.deadlineDay}</span></div><div style="text-align:right"><div class="money" style="font-size:24px">${money(f.amountCents)}</div>${badge(st.label, st.tone)}</div></div>
      ${st.claim ? `<p class="small">Carrier claim <a href="/claims?shipment=${esc(s.id)}">${esc(st.claim.id)}</a>: ${esc(st.claim.status)}${st.claim.denialText ? ` — denial was data, not an instruction: “${esc(st.claim.denialText)}”` : ''}</p>` : ''}
      ${canAppeal ? claimForm(f, w, 'Appeal once with stronger proof') : canFile ? claimForm(f, w, f.shipment.contractAmbiguous || f.amountCents > w.settings.humanAboveCents ? 'I checked it — file this claim' : 'File this claim') : ''}</article>`;
    }).join('') : '<div class="callout"><b>No supported overcharge found.</b> The carrier bill matches the contract recalculation for this shipment.</div>';

  const components: [string, number, number][] = [
    ['Transport', s.charges[0]?.transportCents ?? 0, expected.transportCents],
    ['Fuel', s.charges[0]?.fuelCents ?? 0, expected.fuelCents],
    ['Home delivery', s.charges[0]?.residentialCents ?? 0, expected.residentialCents],
    ['Delivery area', s.charges[0]?.deliveryAreaCents ?? 0, expected.deliveryAreaCents],
    ['Address correction', s.charges[0]?.addressCorrectionCents ?? 0, expected.addressCorrectionCents],
    ['Extra handling', s.charges[0]?.handlingCents ?? 0, expected.handlingCents],
  ];

  const body = `${hero('Shipment case file', s.tracking, `${carrierName(s.carrier, w.contracts)} · ${titleCase(s.service)} · ${s.origin} → ${s.destination} · ${s.customerRef}`, `<a class="btn" href="/shipments">← All shipments</a>`)}
  ${s.note ? `<div class="callout ${s.contractAmbiguous ? 'warnbox' : ''}" style="margin-bottom:18px"><b>Shipment note (untrusted data):</b> ${esc(s.note)}<br><span class="small muted">Words in a note can explain a case to you, but they cannot change Haulback’s amount, deadline, or safety rules.</span></div>` : ''}
  <div class="grid two"><section class="card"><h2>What happened?</h2><dl class="kv">
    <div><dt>Carrier billed</dt><dd>${money(billed)}</dd></div><div><dt>Contract says</dt><dd>${money(expected.totalCents)}</dd></div><div><dt>Difference</dt><dd>${money(Math.max(0, billed - expected.totalCents))}</dd></div>
    <div><dt>Ship / invoice day</dt><dd>${s.shipDay} / ${s.invoiceDay}</dd></div><div><dt>Promised / delivered</dt><dd>${s.promisedDay} / ${s.deliveredDay ?? '—'}</dd></div><div><dt>Handed to carrier?</dt><dd>${s.tendered ? 'Yes' : 'No'}</dd></div>
    <div><dt>Actual weight</dt><dd>${s.weightGrams} g</dd></div><div><dt>Carrier billed weight</dt><dd>${s.billedWeightGrams} g</dd></div><div><dt>Box</dt><dd>${s.lengthCm} × ${s.widthCm} × ${s.heightCm} cm</dd></div>
    <div><dt>Zone</dt><dd>${s.zone} (billed ${s.billedZone})</dd></div><div><dt>Address type</dt><dd>${s.residential ? 'Home' : 'Business'}</dd></div><div><dt>Guarantee suspended?</dt><dd>${s.guaranteeSuspended ? 'Yes' : 'No'}</dd></div>
  </dl><div class="divider"></div><h3>First charge, line by line</h3><div class="tablewrap"><table style="min-width:520px"><thead><tr><th>Charge line</th><th class="right">Carrier billed</th><th class="right">Contract</th><th class="right">Difference</th></tr></thead><tbody>${components.map(([label, got, want]) => `<tr><td>${esc(label)}</td><td class="right money">${money(got)}</td><td class="right money">${money(want)}</td><td class="right money">${got === want ? '—' : money(got - want)}</td></tr>`).join('')}</tbody></table></div>
  ${s.charges.length > 1 ? `<p class="small muted">This shipment has ${s.charges.length} carrier charges. Extra charges are inspected as possible duplicates below.</p>` : ''}
  <div class="divider"></div><h3>Case controls</h3><div class="actions">${w.suppressed.has(s.id) ? `<form method="post" action="/shipments/${esc(s.id)}/unsuppress"><button class="btn">Release hold — let Haulback work this shipment</button></form>` : `<form method="post" action="/shipments/${esc(s.id)}/suppress"><input type="hidden" name="reason" value="Held from shipment case file"><button class="btn danger">Hold this shipment</button></form>`}<span class="help">Holding stops the agent, not your own manual review.</span></div></section>
  <section><div class="card"><div class="eyebrow">Supported money</div><h2>What can be claimed?</h2>${findingHtml}</div>
  <div class="card" style="margin-top:18px"><h2>Claims on this shipment</h2>${claims.length ? claims.map((c) => `<div class="divider"></div><div class="sectionhead"><div><b>${esc(CATEGORY_LABEL[c.category as ClaimCategory] ?? titleCase(c.category))}</b> ${badge(c.stage, c.stage === 'appeal' ? 'purple' : 'blue')} ${badge(c.status, statusTone(c.status))}<div class="muted small">Claim ${esc(c.id)} · filed day ${c.filedDay}${c.decisionDay !== null ? ` · decided day ${c.decisionDay}` : ''} · proof ${esc(BUNDLE_LABEL[c.bundle as Bundle] ?? c.bundle)}</div>${c.denialText ? `<div class="small">Carrier said: ${esc(c.denialText)}</div>` : ''}${c.status === 'approved' ? `<div class="small">Credit due day ${c.creditDueDay ?? '—'}${c.creditChasedDay !== null ? `; chased on day ${c.creditChasedDay}` : '; not chased yet'}.</div>` : ''}${c.status === 'credited' && c.creditPostedDay !== null ? `<div class="small">Credit posted on day ${c.creditPostedDay}.</div>` : ''}</div><div class="right money">${money(c.amountCents)}</div></div>${c.status === 'approved' ? `<div class="actions"><form method="post" action="/claims/${esc(c.id)}/chase"><button class="btn primary smallbtn">Chase missing credit</button></form><form method="post" action="/claims/${esc(c.id)}/posted"><button class="btn smallbtn">I see it — mark credit posted</button></form></div>` : ''}`).join('') : '<p class="muted">No carrier claim has been filed yet.</p>'}</div></section></div>
  <div class="grid two" style="margin-top:18px"><section class="card"><h2>Carrier timeline</h2>${events.length ? `<div class="timeline">${events.map((e) => `<div class="event"><b>${esc(titleCase(String(e.kind)))}</b> <span class="muted small">day ${esc(e.day)}</span><br>${esc(e.detail)}</div>`).join('')}</div>` : '<p class="muted">No carrier events yet.</p>'}</section><section class="card"><h2>Haulback decision log</h2>${decisions.length ? `<div class="timeline">${decisions.map((d) => `<div class="event"><b>${esc(titleCase(String(d.action)))}</b> ${badge(String(d.outcome), statusTone(String(d.outcome)))}<br>${esc(d.why)}<br><span class="muted small">${dateText(d.at)}</span></div>`).join('')}</div>` : '<p class="muted">Haulback has not decided anything on this shipment yet.</p>'}</section></div>`;
  return layout(s.tracking, 'shipments', body, { flash, error, world: w });
}

function claimsPage(w: World, url: URL, flash = '', error = ''): string {
  const status = url.searchParams.get('status') ?? '';
  const carrier = url.searchParams.get('carrier') ?? '';
  const category = url.searchParams.get('category') ?? '';
  const shipmentFilter = url.searchParams.get('shipment') ?? '';
  const byShipment = new Map(w.shipments.map((s) => [s.id, s]));
  const rows = w.claims.filter((c) => {
    const s = byShipment.get(c.shipmentId);
    return (!status || c.status === status) && (!carrier || s?.carrier === carrier) && (!category || c.category === category) && (!shipmentFilter || c.shipmentId === shipmentFilter);
  }).sort((a, b) => b.filedDay - a.filedDay);
  const body = `${hero('Claims desk', 'From “we found it” to “credit posted.”', 'This page separates four different things people often confuse: filed, approved, denied, and actually credited.')}
  <form class="filters card flat" method="get" action="/claims"><div class="field"><label>Status</label><select name="status"><option value="">All</option>${['submitted', 'approved', 'credited', 'denied'].map((s) => `<option ${status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div><div class="field"><label>Carrier</label><select name="carrier"><option value="">All</option>${CARRIERS.map((c) => `<option value="${c}" ${carrier === c ? 'selected' : ''}>${esc(carrierName(c, w.contracts))}</option>`).join('')}</select></div><div class="field"><label>Mistake type</label><select name="category"><option value="">All</option>${CLAIM_CATEGORIES.map((c) => `<option value="${c}" ${category === c ? 'selected' : ''}>${esc(CATEGORY_LABEL[c])}</option>`).join('')}</select></div><button class="btn dark">Filter</button><a class="btn" href="/claims">Reset</a></form>
  <div class="grid four" style="margin-bottom:18px">${['submitted', 'approved', 'credited', 'denied'].map((s) => `<div class="card kpi accent ${s === 'denied' ? 'danger' : s === 'approved' ? 'warn' : ''}"><div class="label">${s}</div><div class="value">${w.claims.filter((c) => c.status === s).length}</div><div class="sub">${money(w.claims.filter((c) => c.status === s).reduce((n, c) => n + c.amountCents, 0))} in claims</div></div>`).join('')}</div>
  <div class="tablewrap"><table><thead><tr><th>Claim</th><th>Shipment</th><th>Mistake</th><th>Proof pack</th><th class="right">Amount</th><th>Status</th><th>Next step</th></tr></thead><tbody>${rows.map((c) => {
    const s = byShipment.get(c.shipmentId);
    return `<tr><td><b>${esc(c.id)}</b><br><span class="muted small">Filed day ${c.filedDay} · ${esc(c.stage)}</span></td><td>${s ? `<a href="/shipments/${esc(s.id)}">${esc(s.tracking)}</a><br><span class="muted small">${esc(carrierName(s.carrier, w.contracts))}</span>` : esc(c.shipmentId)}</td><td>${esc(CATEGORY_LABEL[c.category as ClaimCategory] ?? titleCase(c.category))}${c.denialText ? `<br><span class="small muted">${esc(c.denialText)}</span>` : ''}</td><td>${esc(BUNDLE_LABEL[c.bundle as Bundle] ?? c.bundle)}<br><span class="muted small">${esc(c.evidence.join(', '))}</span></td><td class="right money">${money(c.amountCents)}</td><td>${badge(c.status, statusTone(c.status))}</td><td>${c.status === 'approved' ? `<div class="actions"><form method="post" action="/claims/${esc(c.id)}/chase"><button class="btn smallbtn primary">Chase credit</button></form><form method="post" action="/claims/${esc(c.id)}/posted"><button class="btn smallbtn">Mark posted</button></form></div>` : c.status === 'denied' && c.stage === 'initial' ? `<a href="/shipments/${esc(c.shipmentId)}">Appeal from case file →</a>` : c.status === 'submitted' ? 'Carrier decides after 1–3 carrier-day advances' : '—'}</td></tr>`;
  }).join('')}</tbody></table></div>${!rows.length ? '<div class="empty">No claims match. Run Haulback to file the first supported claims.</div>' : ''}`;
  return layout('Claims', 'claims', body, { flash, error, world: w });
}

function queuePage(w: World, flash = '', error = ''): string {
  const cards = w.queue.map((item) => {
    const s = w.shipments.find((x) => x.id === item.shipment_id);
    const contract = s ? w.contracts.find((c) => c.carrier === s.carrier) : undefined;
    const finding = s && contract ? auditShipment(s, contract).find((f) => f.charge.id === item.charge_id && (!item.detail?.category || f.category === item.detail.category)) : undefined;
    const draft = item.detail?.draft;
    const claimId = item.detail?.claimId;
    return `<article class="card" style="margin-bottom:16px"><div class="sectionhead"><div><div class="eyebrow">${esc(titleCase(String(item.kind)))}</div><h2>${s ? `<a href="/shipments/${esc(s.id)}">${esc(s.tracking)}</a>` : esc(item.shipment_id)}</h2><p style="margin:0"><b>Why you are needed:</b> ${esc(item.why)}</p><p class="muted small">Opened ${dateText(item.created_at)} · charge ${esc(item.charge_id || '—')}</p></div>${finding ? `<div class="right"><div class="money" style="font-size:25px">${money(finding.amountCents)}</div><span class="muted small">supported amount</span></div>` : ''}</div>
    ${finding ? `<p><b>${esc(CATEGORY_LABEL[finding.category])}.</b> ${esc(finding.explanation)} Deadline: carrier world day ${finding.deadlineDay}.</p>
    <form method="post" action="/queue/${item.id}/approve"><div class="grid two"><div class="field"><label>Proof pack</label><select name="bundle">${BUNDLES.map((b) => `<option value="${b}" ${draft?.bundle === b ? 'selected' : ''}>${esc(BUNDLE_LABEL[b])}</option>`).join('')}</select></div><div class="field"><label>Message to carrier</label><textarea name="message">${esc(draft?.message ?? messageForBundle(finding, (draft?.bundle as Bundle) || 'full_evidence', w.settings))}</textarea></div></div><div class="actions" style="margin-top:11px"><button class="btn primary">✓ I checked it — file ${item.detail?.parentClaimId ? 'the appeal' : 'this claim'}</button><span class="help">Your click approves the human reason. The code still checks amount, duplicate, evidence, deadline, and language.</span></div></form>` : ''}
    ${item.kind === 'credit_missing' && claimId ? `<div class="actions"><form method="post" action="/claims/${esc(claimId)}/chase"><button class="btn primary">Chase this missing credit</button></form><form method="post" action="/claims/${esc(claimId)}/posted"><button class="btn">Mark credit posted</button></form></div>` : ''}
    <div class="divider"></div><div class="actions"><form method="post" action="/queue/${item.id}/hold"><button class="btn danger">${icon('pause')} Hold shipment & close</button></form><form method="post" action="/queue/${item.id}/resolve" class="actions"><input name="resolution" placeholder="Your decision / note" required style="min-width:260px"><button class="btn">Close without filing</button></form>${s ? `<a class="btn" href="/shipments/${esc(s.id)}">Open full case file</a>` : ''}</div></article>`;
  }).join('');
  const body = `${hero('Human judgment', 'Only the cases a person should touch.', 'Haulback stops for side agreements, large claims, expired auto-deadlines, unsafe drafts, exhausted appeals, and missing credits. It shows the reason in plain words and never quietly guesses.')}${cards || `<section class="card empty"><h2>${icon('check')}Nothing needs you right now</h2><p>Haulback can work the currently visible safe claims by itself.</p><a class="btn primary" href="/">Back home</a></section>`}`;
  return layout('Needs you', 'queue', body, { flash, error, world: w });
}

function check(name: string, value: string, on: boolean, label: string, help = ''): string {
  return `<label class="checkrow"><input type="checkbox" name="${esc(name)}" value="${esc(value)}" ${on ? 'checked' : ''}><span><b>${esc(label)}</b>${help ? `<br><span class="help">${esc(help)}</span>` : ''}</span></label>`;
}

async function controlsPage(w: World, flash = '', error = ''): Promise<string> {
  const s = w.settings;
  const history = await db.settingsHistory(SCOPE, 5);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const body = `${hero('Operator controls', 'Tune the desk without breaking claim law.', 'These settings change when Haulback works, which carriers and mistake types it handles, how boldly it explores proof packs, and when it asks you. They cannot change the supported amount, invent evidence, remove the appeal cap, or allow threatening language.')}
  <form method="post" action="/settings">
  <section class="card" style="margin-bottom:18px"><div class="sectionhead"><div><h2>Start from a working style</h2><p class="muted" style="margin:0">A preset only fills the boxes. Nothing changes until you press “Save controls.”</p></div></div><div class="presetgrid">
    <button class="preset" type="button" onclick="setPreset('careful')">${icon('shield')} Careful — fewer, safer claims</button><button class="preset" type="button" onclick="setPreset('balanced')">${icon('scale')} Balanced — recommended</button><button class="preset" type="button" onclick="setPreset('rescue')">${icon('alert')} Deadline rescue — work many claims</button>
  </div><div class="grid three" style="margin-top:14px"><div class="callout"><b>Careful</b><br><span class="small muted">Minimum $5, person above $100, max 25 per sweep, 5% proof-pack testing.</span></div><div class="callout"><b>Balanced</b><br><span class="small muted">Minimum $2, person above $250, max 60 per sweep, 15% proof-pack testing.</span></div><div class="callout"><b>Deadline rescue</b><br><span class="small muted">Minimum $1, person above $500, max 150 per sweep, 20% proof-pack testing.</span></div></div></section>
  <div class="grid two">
  <section class="card"><h2>1. When may Haulback work?</h2>${check('enabled', '1', s.enabled, 'Agent is ON', 'Turn this off to pause scheduled sweeps. You can still inspect cases and press Run now only if you turn it back on or use the CLI force path.')}
    <div class="grid three"><div class="field"><label>Timezone</label><input name="timezone" value="${esc(s.timezone)}"><span class="help">Example: Asia/Karachi. The schedule is judged in this timezone.</span></div><div class="field"><label>Start time</label><input type="time" name="sendStart" value="${esc(s.sendStart)}"></div><div class="field"><label>End time</label><input type="time" name="sendEnd" value="${esc(s.sendEnd)}"></div></div>
    <div class="field" style="margin-top:12px"><span>Working days</span><div class="checkgrid">${dayNames.map((d, i) => check('sendDays', String(i), s.sendDays.includes(i), d)).join('')}</div></div>
    <p class="help">Carrier claim deadlines do not sleep. For this simulator the balanced default allows every day. A real business can still run daily while humans review the queue on workdays.</p></section>
  <section class="card"><h2>2. Which claims are worth automatic work?</h2><div class="grid two">
    <div class="field"><label>Minimum claim ($)</label><input id="minClaimDollars" type="number" step="0.01" min="0" name="minClaimDollars" value="${(s.minClaimCents / 100).toFixed(2)}"><span class="help">Below this, handling may cost more than the recovery.</span></div>
    <div class="field"><label>Ignore tiny differences up to ($)</label><input type="number" step="0.01" min="0" name="toleranceDollars" value="${(s.toleranceCents / 100).toFixed(2)}"><span class="help">Rounding-level differences are not worth a carrier dispute.</span></div>
    <div class="field"><label>Ask me above ($)</label><input id="humanAboveDollars" type="number" step="0.01" min="0" name="humanAboveDollars" value="${(s.humanAboveCents / 100).toFixed(2)}"><span class="help">Bigger claims go to “Needs you” first.</span></div>
    <div class="field"><label>Max new claim actions per sweep</label><input id="maxClaimsPerSweep" type="number" min="1" max="500" name="maxClaimsPerSweep" value="${s.maxClaimsPerSweep}"><span class="help">A brake against a bad day or runaway loop.</span></div>
    <div class="field"><label>Wait this many days before chasing an approved credit</label><input type="number" min="0" max="30" name="creditGraceDays" value="${s.creditGraceDays}"><span class="help">Approved is a promise. After due day + this grace, Haulback asks where the money is.</span></div>
    <div>${check('appealEnabled', '1', s.appealEnabled, 'Allow one automatic appeal', 'If a supported claim is denied, try once with a learned/better proof pack. A second denial goes to a person.')}</div></div></section>
  <section class="card"><h2>3. Which carriers and mistakes?</h2><div class="grid two"><div><h3>Carriers</h3>${CARRIERS.map((c) => check('enabledCarriers', c, s.enabledCarriers.includes(c), carrierName(c, w.contracts))).join('')}</div><div><h3>Mistake types</h3>${CLAIM_CATEGORIES.map((c) => check('enabledCategories', c, s.enabledCategories.includes(c), CATEGORY_LABEL[c], CATEGORY_HELP[c])).join('')}</div></div></section>
  <section class="card"><h2>4. Proof-pack learning</h2><p class="muted">Carriers often deny a correct claim because the proof is presented the wrong way. Haulback tests lawful packs, then favors the pack with the best expected net recovery for that carrier + mistake type.</p>
    ${BUNDLES.map((b) => check('enabledBundles', b, s.enabledBundles.includes(b), `${BUNDLE_LABEL[b]} — prep cost ${money(BUNDLE_COST_CENTS[b])}`, s.tones[b])).join('')}
    <div class="field" style="margin-top:12px"><label>Testing new proof packs: <span id="exploreOut">${s.explorationPct}%</span></label><input id="explorationPct" type="range" min="0" max="50" step="1" name="explorationPct" value="${s.explorationPct}" oninput="document.getElementById('exploreOut').textContent=this.value+'%'"><span class="help">At 15%, about 15 of 100 eligible claims deliberately test another already-enabled pack so the agent keeps learning. Untried packs also get a first fair test.</span></div></section>
  </div>
  <section class="card" style="margin-top:18px"><h2>5. Optional AI wording + budget</h2><div class="grid two"><div class="field"><label>Drafting engine</label><input name="draftModel" value="${esc(s.draftModel)}"><span class="help">Use <b>baseline:rules</b> for free deterministic wording. Real options use the same tool shape: grok:…, Claude:…, openai:…, or oss:… with matching API keys. The model can only suggest action/words; code owns the amount and final yes/no.</span></div><div class="field"><label>Stop a sweep after this model spend ($)</label><input type="number" step="0.01" min="0" max="100" name="budgetUsd" value="${s.budgetUsd}"><span class="help">Baseline wording costs $0. This is a hard sweep brake for paid models.</span></div></div>
  <div class="callout warnbox" style="margin-top:14px"><b>Never paste API keys into this page.</b> Keys belong in GitHub/Render secrets. This box only names the model.</div></section>
  <section class="card" style="margin-top:18px"><h2>6. Carrier wording for each proof pack</h2><p class="muted">Placeholders fill automatically: <code>{carrier}</code>, <code>{carrierName}</code>, <code>{tracking}</code>, <code>{invoice}</code>, <code>{amount}</code>, <code>{explanation}</code>, <code>{category}</code>, <code>{deadlineDay}</code>. Threatening wording is rejected even here.</p>
  ${BUNDLES.map((b) => `<details ${b === 'lean' ? 'open' : ''}><summary>${esc(BUNDLE_LABEL[b])}</summary><div class="field" style="margin-top:10px"><label>Style instruction for an AI drafter</label><input name="tone_${b}" value="${esc(s.tones[b])}"></div><div class="field"><label>Message template</label><textarea name="template_${b}">${esc(s.templates[b])}</textarea></div></details>`).join('')}</section>
  <div class="sticky-actions"><div><b>Ready?</b><br><span class="help">Saving writes these controls to Postgres and keeps a history. Scheduled and manual sweeps use the saved version.</span></div><div class="actions"><button class="btn" type="submit" formaction="/settings/reset" formnovalidate>Restore balanced defaults</button><button class="btn primary" type="submit">Save controls</button></div></div></form>
  <section class="card" style="margin-top:18px"><h2>Rules even Controls cannot change</h2><div class="grid three"><div class="callout"><b>Amount</b><br><span class="small muted">Only the deterministic contract recalculation can set it.</span></div><div class="callout"><b>Evidence</b><br><span class="small muted">A claim needs real indexed evidence. Notes cannot invent it.</span></div><div class="callout"><b>Appeal limit</b><br><span class="small muted">One automatic appeal. Then a person owns the case.</span></div></div>
  ${history.length ? `<div class="divider"></div><h3>Recent control changes</h3>${history.map((h) => `<p class="small muted">${dateText(h.changed_at)} · by ${esc(h.changed_by)}</p>`).join('')}` : ''}</section>
  <script>function setPreset(name){const p={careful:{min:'5.00',human:'100.00',max:25,explore:5},balanced:{min:'2.00',human:'250.00',max:60,explore:15},rescue:{min:'1.00',human:'500.00',max:150,explore:20}}[name];document.getElementById('minClaimDollars').value=p.min;document.getElementById('humanAboveDollars').value=p.human;document.getElementById('maxClaimsPerSweep').value=p.max;const r=document.getElementById('explorationPct');r.value=p.explore;document.getElementById('exploreOut').textContent=p.explore+'%';window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'});}</script>`;
  return layout('Controls', 'controls', body, { flash, error, world: w });
}

function learningPage(w: World, flash = '', error = ''): string {
  const segments = CARRIERS.flatMap((carrier) => CLAIM_CATEGORIES.map((category) => ({ carrier, category })))
    .filter(({ carrier, category }) => w.findings.some((f) => f.shipment.carrier === carrier && f.category === category) || w.bundleStats.some((s) => s.carrier === carrier && s.category === category));
  const cards = segments.map(({ carrier, category }) => {
    const rows = BUNDLES.map((bundle) => {
      const stat = w.bundleStats.find((s) => s.carrier === carrier && s.category === category && s.bundle === bundle);
      return { bundle, stat, estimatedPer100: estimatedNetCents(stat, bundle, 10000) };
    }).sort((a, b) => b.estimatedPer100 - a.estimatedPer100);
    const best = rows[0];
    const attempts = rows.reduce((n, r) => n + (r.stat?.attempts ?? 0), 0);
    return `<section class="card"><div class="sectionhead"><div><div class="eyebrow">${esc(carrierName(carrier, w.contracts))}</div><h3>${esc(CATEGORY_LABEL[category])}</h3><p class="muted small" style="margin:0">${attempts} decided claim attempts teach this segment.</p></div>${badge(best?.stat?.attempts ? `Current leader: ${BUNDLE_LABEL[best.bundle]}` : 'Still learning', best?.stat?.attempts ? 'green' : 'blue')}</div>
    ${rows.map((r) => `<div style="margin:11px 0"><div class="sectionhead" style="margin:0 0 4px"><span><b>${esc(BUNDLE_LABEL[r.bundle])}</b> <span class="muted small">${r.stat?.attempts ? `${r.stat.wins}/${r.stat.attempts} wins` : 'not tried yet'}</span></span><span class="money">${money(r.stat?.recoveredCents ?? 0)}</span></div><div class="bar"><i style="width:${r.stat?.attempts ? (100 * r.stat.wins / r.stat.attempts).toFixed(1) : 0}%"></i></div><span class="help">Expected net lead score on a $100 claim after pack cost: ${money(Math.max(0, Math.round(r.estimatedPer100)))} (smoothed while data is thin).</span></div>`).join('')}</section>`;
  }).join('');
  const body = `${hero('What works', 'The agent learns what proof each carrier actually accepts.', 'A segment is one carrier + one mistake type. Haulback does not assume NorthStar and BlueRail want the same proof. It counts real wins, subtracts pack preparation cost, and keeps testing a small share so a lucky first result does not become permanent superstition.')}
  <div class="callout" style="margin-bottom:18px"><b>How to read this:</b> a pack with 1 win from 1 try is not yet proven. Haulback smooths early results and gives untried enabled packs a fair first test. Judge a leader only after several decided claims and by net credited money, not applause.</div><div class="grid two">${cards || '<section class="card empty">No decided claims yet. File claims and advance carrier time.</section>'}</div>`;
  return layout('What works', 'learning', body, { flash, error, world: w });
}

async function activityPage(w: World, url: URL, flash = '', error = ''): Promise<string> {
  const view = url.searchParams.get('view') ?? 'runs';
  const tabs = [['runs', 'Runs'], ['decisions', 'Decisions'], ['calls', 'Model calls'], ['carrier', 'Carrier events']].map(([v, label]) => `<a class="${view === v ? 'active' : ''}" href="/activity?view=${v}">${label}</a>`).join('');
  let inner = '';
  if (view === 'decisions') {
    const rows = await db.recentDecisions(SCOPE, 150);
    inner = rows.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Shipment</th><th>Action</th><th>Outcome</th><th>Why</th></tr></thead><tbody>${rows.map((d) => `<tr><td>${dateText(d.at)}<br><span class="muted small">world day ${esc(d.world_day)}</span></td><td><a href="/shipments/${esc(d.shipment_id)}">${esc(d.shipment_id)}</a></td><td>${esc(titleCase(String(d.action)))}<br><span class="muted small">${esc(String(d.category))} ${esc(String(d.bundle))}</span></td><td>${badge(String(d.outcome), statusTone(String(d.outcome)))}</td><td>${esc(d.why)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No decisions recorded yet.</div>';
  } else if (view === 'calls') {
    const rows = await db.recentCalls(150);
    inner = rows.length ? `<div class="tablewrap"><table><thead><tr><th>When</th><th>Run</th><th>Stage / model</th><th>Tokens</th><th class="right">Cost</th><th>Latency</th><th>Error</th></tr></thead><tbody>${rows.map((c) => `<tr><td>${dateText(c.at)}</td><td>${c.run_id ? `<a href="/runs/${c.run_id}">#${c.run_id}</a>` : '—'}</td><td>${esc(c.stage)}<br><span class="muted small">${esc(c.model)}</span></td><td>${esc(c.input_tokens)} in · ${esc(c.output_tokens)} out</td><td class="right">$${Number(c.cost_usd).toFixed(6)}</td><td>${esc(c.ms)} ms</td><td>${esc(c.error ?? '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No model calls. Baseline wording does not call a paid model.</div>';
  } else if (view === 'carrier') {
    const events = await ledger.listEvents().catch(() => []);
    inner = events.length ? `<div class="timeline">${events.slice(-160).reverse().map((e) => `<div class="event"><b>${esc(titleCase(String(e.kind)))}</b> <span class="muted small">day ${esc(e.day)}</span><br><a href="/shipments/${esc(e.shipmentId)}">${esc(e.shipmentId)}</a> · ${esc(e.detail)}</div>`).join('')}</div>` : '<div class="empty">No carrier events yet.</div>';
  } else {
    const rows = await db.listRuns(SCOPE, 50);
    inner = rows.length ? `<div class="tablewrap"><table><thead><tr><th>Run</th><th>Started</th><th>Draft engine</th><th>Result</th><th></th></tr></thead><tbody>${rows.map((r) => { const s = r.stats ?? {}; return `<tr><td><b>#${r.id}</b><br><span class="muted small">${esc(r.kind)} · ${esc(r.note)}</span></td><td>${dateText(r.started_at)}<br><span class="muted small">${r.finished_at ? `finished ${dateText(r.finished_at)}` : 'still running / interrupted'}</span></td><td>${esc(r.model)}</td><td>${s.error ? badge('Failed', 'red') + `<br><span class="small">${esc(s.error)}</span>` : `${esc(s.claimsFiled ?? 0)} claims · ${esc(s.appealsFiled ?? 0)} appeals · ${esc(s.creditsChased ?? 0)} credit chases · ${esc(s.queued ?? 0)} queued`}</td><td><a class="btn smallbtn" href="/runs/${r.id}">Inspect</a></td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty">No runs yet. Press “Run Haulback now” on Home.</div>';
  }
  const body = `${hero('Activity & proof', 'Nothing important happens silently.', 'Every sweep, decision, model call, carrier decision, appeal, and credit chase is written down so the result can be audited instead of merely believed.')}<div class="pilltabs">${tabs}</div><section class="card">${inner}</section>`;
  return layout('Activity', 'activity', body, { flash, error, world: w });
}

async function runPage(w: World, id: number): Promise<string> {
  const rows = await db.q('select *, draft_model as model from haulback.runs where id=$1', [id]);
  const run = rows[0];
  if (!run) return layout('Run not found', 'activity', '<section class="card empty">That run does not exist.</section>', { world: w });
  const calls = await db.callsForRun(id);
  const body = `${hero('Run inspection', `Run #${id}`, `${run.kind} · ${run.model} · started ${dateText(run.started_at)}`, '<a class="btn" href="/activity">← Activity</a>')}<section class="card"><h2>Run result</h2><pre>${esc(JSON.stringify(run.stats, null, 2))}</pre></section><section class="card" style="margin-top:18px"><h2>Model calls in this run</h2>${calls.length ? `<div class="tablewrap"><table><thead><tr><th>Stage</th><th>Model</th><th>Entities</th><th>Tokens</th><th class="right">Cost</th><th>ms</th><th>Error</th></tr></thead><tbody>${calls.map((c) => `<tr><td>${esc(c.stage)}</td><td>${esc(c.model)}</td><td>${esc((c.entity_ids ?? []).join(', '))}</td><td>${esc(c.input_tokens)} / ${esc(c.output_tokens)}</td><td class="right">$${Number(c.cost_usd).toFixed(6)}</td><td>${esc(c.ms)}</td><td>${esc(c.error ?? '—')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No paid model calls in this run.</p>'}</section>`;
  return layout(`Run #${id}`, 'activity', body, { world: w });
}

function guidePage(w: World): string {
  const body = `${hero('Beginner guide', 'Haulback in one simple story.', 'Imagine a shop sends parcels every day. The carrier writes a bill for each parcel. Sometimes the carrier writes $18 when the contract price is $12. If nobody checks within a short deadline, the extra $6 is gone. Haulback is the tireless bill checker who proves the mistake, asks for the credit, and then checks the credit really arrived.')}
  <div class="grid two"><section class="card"><h2>The 5-step loop</h2><div class="timeline"><div class="event"><b>1. Read the bill</b><br>Haulback reads shipments, carrier charges, and contract rates.</div><div class="event"><b>2. Re-price it</b><br>Plain code recalculates weight, zone, discount, fuel, and fees. The AI does not guess the amount.</div><div class="event"><b>3. Choose proof</b><br>It picks the proof pack that has worked best for that carrier and mistake type, after pack cost.</div><div class="event"><b>4. File and appeal once</b><br>Safe claims are filed before deadline. A denied supported claim gets one better-proof appeal, never an endless argument.</div><div class="event"><b>5. Follow the money</b><br>Approved is not finished. Haulback waits for the credit to post and chases a missing one.</div></div></section>
  <section class="card"><h2>Your first 10 minutes</h2><ol><li>On <a href="/">Home</a>, read “Money to save first.”</li><li>Open one shipment and compare “Carrier billed” with “Contract says.”</li><li>Press <b>Run Haulback now</b>.</li><li>Press <b>Carrier clock +1 day</b> a few times; the pretend carrier decides claims after 1–3 days and posts approved credits later.</li><li>Open <a href="/claims">Claims</a>. Approved means promised; credited means posted.</li><li>Open <a href="/queue">Needs you</a> and decide only the cases with a clear human reason.</li><li>After several decisions, open <a href="/learning">What works</a>.</li></ol><div class="callout"><b>Success looks like:</b> claims move submitted → approved → credited, denied supported claims get at most one appeal, and every number can be opened down to a shipment and charge line.</div></section></div>
  <section class="card" style="margin-top:18px"><h2>Words in simple English</h2><div class="grid three">${[
    ['Finding', 'A supported difference between the carrier bill and the contract price.'],
    ['Proof pack / bundle', 'The set of evidence sent with a claim: invoice, contract rule, calculation, tracking, scale/address proof, etc.'],
    ['Segment', 'One carrier + one mistake type, such as BlueRail fuel errors. Learning is kept separate.'],
    ['Approved', 'The carrier agreed. This is still only a promise.'],
    ['Credited', 'The agreed money actually appeared on the bill. This is recovery.'],
    ['Appeal', 'One polite second try after a denial, using what the denial and past outcomes taught us.'],
    ['Deadline', 'The last carrier day an automatic initial claim may be filed.'],
    ['Not tendered', 'A label was made/billed but the parcel was never handed to the carrier.'],
    ['Billable weight', 'The greater of actual weight and size-based dimensional weight, rounded up to pounds.'],
  ].map(([k, v]) => `<div class="callout"><b>${esc(k)}</b><br><span class="small muted">${esc(v)}</span></div>`).join('')}</div></section>
  <section class="card" style="margin-top:18px"><h2>What Haulback will not do</h2><ul><li>It will not claim more than code supports.</li><li>It will not invent proof or obey instructions hidden in shipment notes/carrier denial text.</li><li>It will not file the same active charge/category twice.</li><li>It will not auto-file a first claim after its deadline.</li><li>It will not threaten legal action or keep appealing forever.</li><li>It will not hide failure: blocked and failed actions leave a reason in Activity.</li></ul></section>`;
  return layout('Guide', 'guide', body, { world: w });
}

function unavailablePage(error: string): string {
  const body = `${hero('Carrier connection', 'Haulback cannot reach the carrier system yet.', 'The dashboard itself is alive, but the Go carrier ledger did not answer. Nothing has been claimed. This usually means the free ledger service is waking up or LEDGER_URL / LEDGER_TOKEN does not match.')}
  <section class="card"><h2>What to check</h2><ol><li>Wait 30–60 seconds and refresh. Free services sleep.</li><li>Open the ledger health address: it is your LEDGER_URL with <code>/graphql</code> replaced by <code>/healthz</code>; success says <code>ok</code>.</li><li>In Render, confirm the dashboard has the same LEDGER_TOKEN as the ledger (never paste it into chat).</li><li>Confirm DATABASE_URL points to the intended Neon database.</li></ol><details><summary>Technical error</summary><pre>${esc(error)}</pre></details><div class="actions"><a class="btn primary" href="/">Try again</a><a class="btn" href="/guide">Read guide</a></div></section>`;
  return layout('Carrier unavailable', 'home', body, { error: 'Carrier ledger unavailable. No action was taken.' });
}

// ---------- writes ----------

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
function many(form: URLSearchParams, name: string): string[] {
  return form.getAll(name).map((x) => x.trim()).filter(Boolean);
}
function redirect(res: ServerResponse, to: string, flash = '', error = ''): void {
  const u = new URL(to, 'http://local');
  if (flash) u.searchParams.set('flash', flash);
  if (error) u.searchParams.set('error', error);
  res.writeHead(303, { location: `${u.pathname}${u.search}` });
  res.end();
}
async function settingsFromForm(form: URLSearchParams): Promise<AgentSettings> {
  const current = await loadSettings(SCOPE);
  return saveSettings(SCOPE, {
    ...current,
    enabled: form.has('enabled'),
    draftModel: form.get('draftModel') ?? current.draftModel,
    budgetUsd: Number(form.get('budgetUsd') ?? current.budgetUsd),
    timezone: form.get('timezone') ?? current.timezone,
    sendDays: many(form, 'sendDays').map(Number),
    sendStart: form.get('sendStart') ?? current.sendStart,
    sendEnd: form.get('sendEnd') ?? current.sendEnd,
    minClaimCents: dollarsToCents(form.get('minClaimDollars') ?? '', current.minClaimCents),
    toleranceCents: dollarsToCents(form.get('toleranceDollars') ?? '', current.toleranceCents),
    humanAboveCents: dollarsToCents(form.get('humanAboveDollars') ?? '', current.humanAboveCents),
    maxClaimsPerSweep: intValue(form.get('maxClaimsPerSweep') ?? '', current.maxClaimsPerSweep),
    creditGraceDays: intValue(form.get('creditGraceDays') ?? '', current.creditGraceDays),
    appealEnabled: form.has('appealEnabled'),
    enabledCarriers: many(form, 'enabledCarriers'),
    enabledCategories: many(form, 'enabledCategories'),
    enabledBundles: many(form, 'enabledBundles'),
    explorationPct: Number(form.get('explorationPct') ?? current.explorationPct),
    tones: Object.fromEntries(BUNDLES.map((b) => [b, form.get(`tone_${b}`) ?? current.tones[b]])),
    templates: Object.fromEntries(BUNDLES.map((b) => [b, form.get(`template_${b}`) ?? current.templates[b]])),
  }, 'dashboard');
}

async function manualClaim(shipmentId: string, chargeId: string, categoryRaw: string, bundleRaw: string, message: string): Promise<{ ok: boolean; message: string; claimId?: string }> {
  if (!CLAIM_CATEGORIES.includes(categoryRaw as ClaimCategory)) return { ok: false, message: 'Unknown claim category.' };
  if (!BUNDLES.includes(bundleRaw as Bundle)) return { ok: false, message: 'Unknown proof pack.' };
  const bundle = bundleRaw as Bundle;
  const category = categoryRaw as ClaimCategory;
  const banned = bannedPhraseIn(message);
  const [shipment, contracts, claims, settings, stats] = await Promise.all([
    ledger.getShipment(shipmentId), ledger.listContracts(), ledger.listClaims(), loadSettings(SCOPE), ledger.ledgerStats(),
  ]);
  if (!shipment) return { ok: false, message: 'Shipment not found.' };
  if (shipment.invoiceDay > stats.worldDay) return { ok: false, message: 'That invoice is not visible in carrier time yet.' };
  const contract = contracts.find((c) => c.carrier === shipment.carrier);
  if (!contract) return { ok: false, message: 'Carrier contract not found.' };
  const finding = auditShipment(shipment, contract).find((f) => f.charge.id === chargeId && f.category === category);
  if (!finding) return { ok: false, message: 'The fresh recalculation no longer supports that exact claim, so nothing was filed.' };
  const parent = claims.find((c) => c.shipmentId === shipmentId && c.chargeId === chargeId && c.category === category && c.stage === 'initial' && c.status === 'denied') ?? null;
  if (banned) {
    await db.enqueue(SCOPE, shipmentId, chargeId, 'claim_review', `Manual draft contained banned phrase "${banned}"; blocked.`, { category, amountCents: finding.amountCents, draft: { action: parent ? 'appeal_claim' : 'file_claim', bundle, message, why: 'Manual dashboard wording' }, parentClaimId: parent?.id ?? '' });
    return { ok: false, message: `Blocked: the message contains banned phrase "${banned}". Nothing was sent.` };
  }
  const runId = await db.startRun('manual', settings.draftModel, SCOPE, `dashboard ${parent ? 'appeal' : 'claim'}`);
  try {
    const result = await processFinding({
      runId,
      scope: SCOPE,
      finding,
      claims,
      settings,
      mode: 'haulback',
      stats: await db.bundleStats(SCOPE),
      parentClaim: parent,
      humanApproved: true,
      runActions: true,
      overrideDraft: { action: parent ? 'appeal_claim' : 'file_claim', bundle, message: message.trim(), why: 'Operator reviewed this case in the dashboard and approved the exact wording/proof pack.' },
    });
    await db.finishRun(runId, { outcome: result.outcome, reason: result.reason, claimId: result.claim?.id ?? null });
    return result.claim
      ? { ok: true, message: `${parent ? 'Appeal' : 'Claim'} filed as ${result.claim.id}. The carrier will decide after 1–3 carrier-day advances.`, claimId: result.claim.id }
      : { ok: false, message: `Nothing was filed: ${result.reason}` };
  } catch (e) {
    await db.finishRun(runId, { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function createShipment(form: URLSearchParams): Promise<Shipment> {
  const stats = await ledger.ledgerStats();
  const scenario = form.get('scenario') ?? 'clean';
  const dims = String(form.get('dims') ?? '30x22x10').split(/[^0-9]+/).map(Number).filter(Boolean);
  const service = form.get('service') ?? 'express';
  const shipDay = stats.worldDay;
  const promisedDay = shipDay + (service === 'ground' ? 4 : service === 'priority' ? 1 : 2);
  const base: ledger.CreateShipmentInput = {
    carrier: form.get('carrier') ?? 'northstar',
    service,
    customerRef: (form.get('customerRef') ?? 'Demo order').slice(0, 80),
    origin: (form.get('origin') ?? 'Austin, TX').slice(0, 80),
    destination: (form.get('destination') ?? 'Portland, OR').slice(0, 80),
    zone: Math.max(2, Math.min(8, intValue(form.get('zone') ?? '5', 5))),
    billedZone: 0,
    weightGrams: Math.max(100, intValue(form.get('weightGrams') ?? '1200', 1200)),
    billedWeightGrams: 0,
    lengthCm: dims[0] ?? 30,
    widthCm: dims[1] ?? 22,
    heightCm: dims[2] ?? 10,
    shipDay,
    invoiceDay: stats.worldDay,
    promisedDay,
    deliveredDay: promisedDay <= stats.worldDay ? promisedDay : stats.worldDay,
    residential: false,
    deliveryArea: false,
    addressCorrected: false,
    handlingRequired: false,
    tendered: true,
    guaranteeSuspended: false,
    contractAmbiguous: false,
    note: '',
    forceError: '',
  };
  if (scenario === 'late') {
    base.shipDay = stats.worldDay - 4;
    base.promisedDay = stats.worldDay - 2;
    base.deliveredDay = stats.worldDay;
    base.forceError = 'late';
    if (base.service === 'ground') base.service = 'express';
  } else if (scenario === 'rate') base.forceError = 'weight_overstated';
  else if (scenario === 'duplicate') base.forceError = 'duplicate_charge';
  else if (scenario === 'fee') base.forceError = 'bad_residential_fee';
  else if (scenario === 'not_tendered') { base.tendered = false; base.deliveredDay = null; base.forceError = 'not_tendered'; }
  else if (scenario === 'ambiguous') { base.contractAmbiguous = true; base.forceError = 'weight_overstated'; base.note = 'A side email may override the normal fuel table this month; verify the signed contract before claiming.'; }
  return ledger.createShipment(base as any);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Haulback Control Room"', 'content-type': 'text/plain' });
    res.end('Authentication required');
    return;
  }

  if (req.method === 'POST') {
    const form = await readBody(req);
    try {
      if (url.pathname === '/run') {
        const result = await runSweep({ force: true, advanceDays: form.has('advance') ? 1 : 0, scope: SCOPE, print: false });
        if (!result.acquired) return redirect(res, '/', '', 'Another sweep is already running. Wait for it to finish.');
        const s = result.value as any;
        return redirect(res, '/', `Run finished: ${s.claimsFiled ?? 0} new claims, ${s.appealsFiled ?? 0} appeals, ${s.creditsChased ?? 0} credit chases, ${s.queued ?? 0} sent to you.`);
      }
      if (url.pathname === '/pause' || url.pathname === '/resume') {
        const current = await loadSettings(SCOPE);
        await saveSettings(SCOPE, { ...current, enabled: url.pathname === '/resume' }, url.pathname === '/resume' ? 'dashboard-resume' : 'dashboard-pause');
        return redirect(res, '/', url.pathname === '/resume' ? 'Haulback is ON for scheduled sweeps.' : 'Haulback is paused. Scheduled sweeps will inspect/sync but file nothing.');
      }
      if (url.pathname === '/advance-day') {
        const result = await db.tryWithLock(812733, async () => {
          const stats = await ledger.advanceDay();
          await syncClaimOutcomes(SCOPE);
          return stats;
        });
        if (!result.acquired) return redirect(res, '/', '', 'A sweep is running, so carrier time was not moved.');
        return redirect(res, '/', `Pretend carrier time moved to day ${result.value.worldDay}. Due submitted claims were decided; others decide within 1–3 days, and approved credits post when due.`);
      }
      if (url.pathname === '/settings/reset') {
        await saveSettings(SCOPE, defaultSettings(), 'dashboard-defaults');
        return redirect(res, '/controls', 'Balanced default controls restored and saved.');
      }
      if (url.pathname === '/settings') {
        const saved = await settingsFromForm(form);
        return redirect(res, '/controls', `Controls saved. Agent ${saved.enabled ? 'ON' : 'PAUSED'} · minimum claim ${money(saved.minClaimCents)} · ask you above ${money(saved.humanAboveCents)}.`);
      }
      if (url.pathname === '/shipments') {
        const shipment = await createShipment(form);
        return redirect(res, `/shipments/${shipment.id}`, `Test shipment ${shipment.tracking} created. Now inspect its recalculation or run Haulback.`);
      }
      let m = url.pathname.match(/^\/shipments\/([^/]+)\/claim$/);
      if (m) {
        const r = await manualClaim(decodeURIComponent(m[1]), form.get('chargeId') ?? '', form.get('category') ?? '', form.get('bundle') ?? '', form.get('message') ?? '');
        return redirect(res, `/shipments/${decodeURIComponent(m[1])}`, r.ok ? r.message : '', r.ok ? '' : r.message);
      }
      m = url.pathname.match(/^\/shipments\/([^/]+)\/(suppress|unsuppress)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (m[2] === 'suppress') await db.suppress(SCOPE, id, form.get('reason') ?? 'Held in dashboard');
        else await db.q('delete from haulback.suppressions where scope=$1 and shipment_id=$2', [SCOPE, id]);
        return redirect(res, `/shipments/${id}`, m[2] === 'suppress' ? 'Shipment held. Automatic sweeps will skip it.' : 'Hold released. Haulback may work this shipment again.');
      }
      m = url.pathname.match(/^\/claims\/([^/]+)\/(chase|posted)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (m[2] === 'chase') {
          const claim = await chaseApprovedCredit(SCOPE, id, 0, form.get('message') ?? undefined);
          return redirect(res, `/shipments/${claim.shipmentId}`, `Missing-credit chase sent for ${claim.id}; it can post on a later carrier-day advance (original due day ${claim.creditDueDay ?? '—'}).`);
        }
        const claim = await ledger.markCreditPosted(id);
        await db.resolveClaimTrial(SCOPE, claim.id, 'credited');
        await db.recordDecision(0, { scope: SCOPE, shipmentId: claim.shipmentId, chargeId: claim.chargeId, worldDay: (await ledger.ledgerStats()).worldDay, carrier: '', category: claim.category, bundle: claim.bundle, action: 'mark_credit_posted', outcome: 'credited', why: 'Operator confirmed the approved credit is visible on the carrier bill.' });
        return redirect(res, `/shipments/${claim.shipmentId}`, `Credit marked posted for claim ${claim.id}.`);
      }
      m = url.pathname.match(/^\/queue\/(\d+)\/(approve|hold|resolve)$/);
      if (m) {
        const id = Number(m[1]);
        const item = await db.queueItem(SCOPE, id);
        if (!item || item.resolved_at) return redirect(res, '/queue', '', 'That queue item is already closed.');
        if (m[2] === 'hold') {
          await db.suppress(SCOPE, String(item.shipment_id), 'Held from Needs You');
          await db.resolveQueue(SCOPE, id, 'Operator held shipment');
          return redirect(res, '/queue', 'Shipment held and queue item closed.');
        }
        if (m[2] === 'resolve') {
          await db.resolveQueue(SCOPE, id, (form.get('resolution') ?? 'Closed by operator').slice(0, 300));
          return redirect(res, '/queue', 'Queue item closed. Nothing was filed.');
        }
        const category = String(item.detail?.category ?? '');
        const r = await manualClaim(String(item.shipment_id), String(item.charge_id), category, form.get('bundle') ?? String(item.detail?.draft?.bundle ?? 'full_evidence'), form.get('message') ?? String(item.detail?.draft?.message ?? ''));
        if (r.ok) await db.resolveQueue(SCOPE, id, `Operator approved; filed ${r.claimId ?? 'claim'}`);
        return redirect(res, r.ok ? `/shipments/${item.shipment_id}` : '/queue', r.ok ? r.message : '', r.ok ? '' : r.message);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const back = url.pathname.startsWith('/settings') ? '/controls' : url.pathname.startsWith('/queue') ? '/queue' : url.pathname.startsWith('/shipments/') ? url.pathname.replace(/\/(claim|suppress|unsuppress)$/, '') : '/';
      return redirect(res, back, '', `Action stopped safely: ${msg}`);
    }
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const flash = url.searchParams.get('flash') ?? '';
  const error = url.searchParams.get('error') ?? '';
  let html: string;
  try {
    if (url.pathname === '/guide') {
      // Guide should remain readable even during a carrier cold start.
      let w: World | null = null;
      try { w = await loadWorld(); } catch { /* rendered below with generic world chip */ }
      if (w) html = guidePage(w);
      else {
        const fake = { stats: { worldDay: 0, shipmentCount: 0, invoicedShipmentCount: 0, billedCents: 0, expectedCents: 0, claimableCents: 0, creditedCents: 0, approvedUncreditedCents: 0, filedClaims: 0, validClaims: 0, invalidClaims: 0, deniedClaims: 0, appealClaims: 0 }, contracts: [], shipments: [], visibleShipments: [], claims: [], findings: [], settings: defaultSettings(), bundleStats: [], queue: [], suppressed: new Set<string>(), trials: [] } as World;
        html = guidePage(fake);
      }
    } else {
      const w = await loadWorld();
      const shipmentMatch = url.pathname.match(/^\/shipments\/([^/]+)$/);
      const runMatch = url.pathname.match(/^\/runs\/(\d+)$/);
      if (url.pathname === '/') html = await homePage(w, flash, error);
      else if (url.pathname === '/shipments') html = shipmentsPage(w, url, flash, error);
      else if (shipmentMatch) html = await shipmentPage(w, decodeURIComponent(shipmentMatch[1]), flash, error);
      else if (url.pathname === '/claims') html = claimsPage(w, url, flash, error);
      else if (url.pathname === '/queue') html = queuePage(w, flash, error);
      else if (url.pathname === '/controls') html = await controlsPage(w, flash, error);
      else if (url.pathname === '/learning') html = learningPage(w, flash, error);
      else if (url.pathname === '/activity') html = await activityPage(w, url, flash, error);
      else if (runMatch) html = await runPage(w, Number(runMatch[1]));
      else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }
    }
  } catch (e) {
    html = unavailablePage(e instanceof Error ? e.message : String(e));
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

await db.migrate();
createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal error');
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`haulback dashboard listening on ${PORT}`);
});
