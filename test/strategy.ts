import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseBundle, estimatedNetCents, setBanditSeed, type BundleStat } from '../src/strategy.js';

test('untried bundles are tested before exploit', () => {
  setBanditSeed(42);
  assert.equal(chooseBundle([], 'northstar', 'fuel_surcharge', 10000, 0), 'lean');
});

test('learning optimizes net recovery, not just the most expensive pack', () => {
  const stats: BundleStat[] = [
    { carrier: 'northstar', category: 'fuel_surcharge', bundle: 'lean', attempts: 10, wins: 8, filedCents: 100000, recoveredCents: 80000 },
    { carrier: 'northstar', category: 'fuel_surcharge', bundle: 'full_evidence', attempts: 10, wins: 8, filedCents: 100000, recoveredCents: 80000 },
  ];
  assert.ok(estimatedNetCents(stats[0], 'lean', 10000) > estimatedNetCents(stats[1], 'full_evidence', 10000));
});

test('segments do not leak across carriers', () => {
  setBanditSeed(11);
  const stats: BundleStat[] = [
    { carrier: 'northstar', category: 'fuel_surcharge', bundle: 'lean', attempts: 10, wins: 0, filedCents: 1000, recoveredCents: 0 },
    { carrier: 'northstar', category: 'fuel_surcharge', bundle: 'contract_first', attempts: 10, wins: 10, filedCents: 1000, recoveredCents: 1000 },
    { carrier: 'northstar', category: 'fuel_surcharge', bundle: 'operations_pack', attempts: 10, wins: 0, filedCents: 1000, recoveredCents: 0 },
    { carrier: 'northstar', category: 'fuel_surcharge', bundle: 'full_evidence', attempts: 10, wins: 0, filedCents: 1000, recoveredCents: 0 },
  ];
  assert.equal(chooseBundle(stats, 'northstar', 'fuel_surcharge', 10000, 0), 'contract_first');
  assert.equal(chooseBundle(stats, 'bluerail', 'fuel_surcharge', 10000, 0), 'lean');
});
