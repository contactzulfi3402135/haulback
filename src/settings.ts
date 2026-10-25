import * as db from './db.js';
import { bannedPhraseIn, POLICY } from './policy.js';
import { CLAIM_CATEGORIES, type ClaimCategory } from './rating.js';
import { BUNDLES, BUNDLE_TONE, type Bundle } from './strategy.js';

// Operator settings are data stored in Postgres. They can tune timing,
// thresholds, enabled claim types/carriers/bundles, model, and budget
// only inside hard bounds. They cannot change the supported-amount law,
// evidence requirement, appeal cap, or banned language.

export const CARRIERS = ['northstar', 'bluerail', 'continental'] as const;
export type CarrierId = (typeof CARRIERS)[number];

export type AgentSettings = {
  enabled: boolean;
  draftModel: string;
  budgetUsd: number;
  timezone: string;
  sendDays: number[];
  sendStart: string;
  sendEnd: string;

  minClaimCents: number;
  toleranceCents: number;
  humanAboveCents: number;
  maxClaimsPerSweep: number;
  creditGraceDays: number;
  appealEnabled: boolean;

  enabledCarriers: CarrierId[];
  enabledCategories: ClaimCategory[];
  enabledBundles: Bundle[];
  explorationPct: number;
  tones: Record<Bundle, string>;
  templates: Record<Bundle, string>;
};

export const DEFAULT_TEMPLATES: Record<Bundle, string> = {
  lean: 'Hello {carrier} billing team, please credit {amount} for shipment {tracking}, invoice {invoice}. Our contract recalculation shows: {explanation} The supported difference is {amount}.',
  contract_first: 'Hello {carrier} billing team, under the {carrierName} contract rate and fee rules, shipment {tracking} on invoice {invoice} should be credited {amount}. {explanation} Please post the correction to the account.',
  operations_pack: 'Hello {carrier} billing team, the operational record for shipment {tracking} supports a {amount} credit on invoice {invoice}. {explanation} Tracking, delivery, weight/dimension, and address evidence are indexed to this charge.',
  full_evidence: 'Hello {carrier} billing team, please credit {amount} for shipment {tracking}, invoice {invoice}. The indexed pack contains the contract rule, invoice lines, recalculation, and operational proof. {explanation}',
};

export function defaultSettings(): AgentSettings {
  return {
    enabled: true,
    draftModel: 'baseline:rules',
    budgetUsd: 1,
    timezone: 'Asia/Karachi',
    sendDays: [0, 1, 2, 3, 4, 5, 6],
    sendStart: '00:00',
    sendEnd: '23:59',

    minClaimCents: 200,
    toleranceCents: 25,
    humanAboveCents: 25000,
    maxClaimsPerSweep: 60,
    creditGraceDays: 5,
    appealEnabled: true,

    enabledCarriers: [...CARRIERS],
    enabledCategories: [...CLAIM_CATEGORIES],
    enabledBundles: [...BUNDLES],
    explorationPct: 15,
    tones: { ...BUNDLE_TONE },
    templates: { ...DEFAULT_TEMPLATES },
  };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function text(v: unknown, fallback: string, max = 300): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return (s || fallback).slice(0, max);
}
function boundedNumber(name: string, v: unknown, fallback: number, min: number, max: number, integer = false): number {
  const n = v === undefined || v === null || v === '' ? fallback : Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}
function timeText(name: string, v: unknown, fallback: string): string {
  const s = text(v, fallback, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error(`${name} must use HH:MM time`);
  return s;
}
function validTimezone(v: unknown, fallback: string): string {
  const tz = text(v, fallback, 80);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    throw new Error(`Unknown timezone: ${tz}`);
  }
}

export function normalizeSettings(raw: unknown): AgentSettings {
  const d = defaultSettings();
  const r = asRecord(raw);

  const draftModel = text(r.draftModel, d.draftModel, 100);
  const provider = draftModel.split(':')[0]?.toLowerCase();
  if (!/^[a-z]+:.+/.test(draftModel) || !['baseline', 'grok', 'Claude', 'openai', 'oss'].includes(provider)) {
    throw new Error('Draft model must look like baseline:rules, grok:model, Claude:model, openai:model, or oss:model');
  }

  const rawDays = Array.isArray(r.sendDays) ? r.sendDays : d.sendDays;
  const sendDays = [...new Set(rawDays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
  if (!sendDays.length) throw new Error('Choose at least one sending day');

  const sendStart = timeText('Send start', r.sendStart, d.sendStart);
  const sendEnd = timeText('Send end', r.sendEnd, d.sendEnd);
  if (sendEnd <= sendStart) throw new Error('Send end must be after send start (overnight windows are not supported)');

  const enabledCarriers = CARRIERS.filter((c) => (Array.isArray(r.enabledCarriers) ? r.enabledCarriers : d.enabledCarriers).includes(c));
  if (!enabledCarriers.length) throw new Error('Enable at least one carrier');
  const enabledCategories = CLAIM_CATEGORIES.filter((c) => (Array.isArray(r.enabledCategories) ? r.enabledCategories : d.enabledCategories).includes(c));
  if (!enabledCategories.length) throw new Error('Enable at least one claim category');
  const enabledBundles = BUNDLES.filter((b) => (Array.isArray(r.enabledBundles) ? r.enabledBundles : d.enabledBundles).includes(b));
  if (!enabledBundles.length) throw new Error('Enable at least one evidence bundle');

  const rawTones = asRecord(r.tones);
  const rawTemplates = asRecord(r.templates);
  const tones = Object.fromEntries(BUNDLES.map((b) => [b, text(rawTones[b], d.tones[b], 300)])) as Record<Bundle, string>;
  const templates = Object.fromEntries(BUNDLES.map((b) => [b, text(rawTemplates[b], d.templates[b], 1200)])) as Record<Bundle, string>;
  for (const b of BUNDLES) {
    const banned = bannedPhraseIn(templates[b], POLICY);
    if (banned) throw new Error(`${b} template contains banned phrase: ${banned}`);
  }

  return {
    enabled: bool(r.enabled, d.enabled),
    draftModel,
    budgetUsd: boundedNumber('Budget', r.budgetUsd, d.budgetUsd, 0, 100),
    timezone: validTimezone(r.timezone, d.timezone),
    sendDays,
    sendStart,
    sendEnd,

    minClaimCents: boundedNumber('Minimum claim cents', r.minClaimCents, d.minClaimCents, 0, 100000, true),
    toleranceCents: boundedNumber('Tolerance cents', r.toleranceCents, d.toleranceCents, 0, 5000, true),
    humanAboveCents: boundedNumber('Human approval cents', r.humanAboveCents, d.humanAboveCents, 0, 100000000, true),
    maxClaimsPerSweep: boundedNumber('Maximum claims per sweep', r.maxClaimsPerSweep, d.maxClaimsPerSweep, 1, 500, true),
    creditGraceDays: boundedNumber('Credit grace days', r.creditGraceDays, d.creditGraceDays, 0, 30, true),
    appealEnabled: bool(r.appealEnabled, d.appealEnabled),

    enabledCarriers,
    enabledCategories,
    enabledBundles,
    explorationPct: boundedNumber('Exploration %', r.explorationPct, d.explorationPct, 0, 50),
    tones,
    templates,
  };
}

export async function loadSettings(scope = 'live'): Promise<AgentSettings> {
  const raw = await db.getState(`settings:${scope}`);
  if (!raw) return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(scope: string, raw: unknown, changedBy = 'dashboard'): Promise<AgentSettings> {
  const settings = normalizeSettings(raw);
  await db.setState(`settings:${scope}`, JSON.stringify(settings));
  await db.recordSettingsHistory(scope, settings, changedBy);
  return settings;
}

const WEEKDAY_NUMBER: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export type ScheduleStatus = {
  allowed: boolean;
  localTime: string;
  weekday: number;
  reason: string;
};

export function scheduleStatus(settings: AgentSettings, now = new Date()): ScheduleStatus {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = WEEKDAY_NUMBER[part('weekday')] ?? now.getUTCDay();
  const localTime = `${part('hour').padStart(2, '0')}:${part('minute').padStart(2, '0')}`;
  if (!settings.enabled) return { allowed: false, localTime, weekday, reason: 'Agent is paused in the dashboard' };
  if (!settings.sendDays.includes(weekday)) return { allowed: false, localTime, weekday, reason: 'Today is not a selected sending day' };
  if (localTime < settings.sendStart || localTime > settings.sendEnd) {
    return { allowed: false, localTime, weekday, reason: `Outside selected window ${settings.sendStart}–${settings.sendEnd} ${settings.timezone}` };
  }
  return { allowed: true, localTime, weekday, reason: 'Inside selected schedule window' };
}

export function renderTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}
