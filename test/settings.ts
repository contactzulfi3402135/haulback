import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSettings, normalizeSettings, renderTemplate, scheduleStatus } from '../src/settings.js';

test('default controls are valid and balanced', () => {
  const s = normalizeSettings(defaultSettings());
  assert.equal(s.minClaimCents, 200);
  assert.equal(s.humanAboveCents, 25000);
  assert.equal(s.enabledBundles.length, 4);
});

test('unsafe control combinations are rejected', () => {
  assert.throws(() => normalizeSettings({ ...defaultSettings(), enabledBundles: [] }), /at least one evidence bundle/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), sendStart: '10:00', sendEnd: '09:00' }), /after send start/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), templates: { ...defaultSettings().templates, lean: 'Credit this or else.' } }), /banned phrase/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), timezone: 'Mars/Olympus' }), /Unknown timezone/);
});

test('schedule honors pause, day, and timezone window', () => {
  const s = { ...defaultSettings(), timezone: 'UTC', sendDays: [3], sendStart: '09:00', sendEnd: '09:59' };
  const inside = scheduleStatus(s, new Date('2026-10-28T09:15:00Z')); // Wednesday
  assert.equal(inside.allowed, true);
  const outside = scheduleStatus(s, new Date('2026-10-28T11:15:00Z'));
  assert.equal(outside.allowed, false);
  assert.equal(scheduleStatus({ ...s, enabled: false }, new Date('2026-10-28T09:15:00Z')).allowed, false);
});

test('templates render placeholders as values only', () => {
  assert.equal(renderTemplate('Claim {amount} for {tracking}', { amount: '$5.00', tracking: '<script>' }), 'Claim $5.00 for <script>');
});
