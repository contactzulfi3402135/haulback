import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedFor, supportedAmount, type CarrierCharge, type CarrierContract, type Shipment } from '../src/rating.js';

const contract: CarrierContract = {
  carrier: 'test', name: 'Test Carrier', dimDivisor: 5000, discountBps: 1000, fuelBps: 1200,
  residentialFeeCents: 350, deliveryAreaFeeCents: 425, addressCorrectionFeeCents: 1200, handlingFeeCents: 1800,
  serviceClaimWindowDays: 15, billingClaimWindowDays: 60,
  rates: [
    { service: 'ground', baseCents: 650, perPoundCents: 75, zoneStepCents: 55, guaranteed: false },
    { service: 'express', baseCents: 1450, perPoundCents: 135, zoneStepCents: 95, guaranteed: true },
  ],
};
function shipment(mut: Partial<Shipment> = {}): Shipment {
  return {
    id: 'shp-1', tracking: 'HB1', carrier: 'test', service: 'express', customerRef: 'x', origin: 'A', destination: 'B',
    zone: 4, billedZone: 4, shipDay: 0, invoiceDay: 7, promisedDay: 2, deliveredDay: 3,
    weightGrams: 900, billedWeightGrams: 900, lengthCm: 25, widthCm: 18, heightCm: 8,
    residential: false, deliveryArea: false, addressCorrected: false, handlingRequired: false,
    tendered: true, guaranteeSuspended: false, contractAmbiguous: false, note: '', charges: [], ...mut,
  };
}

test('dimensional weight and discount are deterministic', () => {
  const exp = expectedFor(shipment(), contract);
  assert.equal(exp.dimensionalGrams, 720);
  assert.equal(exp.billablePounds, 2);
  assert.equal(exp.transportCents, 1598);
  assert.equal(exp.fuelCents, 192);
});

test('late guaranteed service supports transport plus fuel; suspended supports zero', () => {
  const s = shipment();
  const exp = expectedFor(s, contract);
  const ch: CarrierCharge = { id: 'c1', shipmentId: s.id, invoiceId: 'i1', invoiceDay: 7, transportCents: exp.transportCents, fuelCents: exp.fuelCents, residentialCents: 0, deliveryAreaCents: 0, addressCorrectionCents: 0, handlingCents: 0, totalCents: exp.totalCents };
  assert.equal(supportedAmount(s, contract, ch, 0, 'service_guarantee'), exp.transportCents + exp.fuelCents);
  assert.equal(supportedAmount(shipment({ guaranteeSuspended: true }), contract, ch, 0, 'service_guarantee'), 0);
});

test('ground late delivery is not a guarantee claim', () => {
  const s = shipment({ service: 'ground' });
  const exp = expectedFor(s, contract);
  const ch: CarrierCharge = { id: 'c1', shipmentId: s.id, invoiceId: 'i1', invoiceDay: 7, transportCents: exp.transportCents, fuelCents: exp.fuelCents, residentialCents: 0, deliveryAreaCents: 0, addressCorrectionCents: 0, handlingCents: 0, totalCents: exp.totalCents };
  assert.equal(supportedAmount(s, contract, ch, 0, 'service_guarantee'), 0);
});

test('duplicate and not-tendered calculations do not overlap', () => {
  const s = shipment({ tendered: false, deliveredDay: null });
  const ch: CarrierCharge = { id: 'c2', shipmentId: s.id, invoiceId: 'i1', invoiceDay: 7, transportCents: 1000, fuelCents: 100, residentialCents: 0, deliveryAreaCents: 0, addressCorrectionCents: 0, handlingCents: 0, totalCents: 1100 };
  assert.equal(supportedAmount(s, contract, ch, 0, 'not_tendered'), 1100);
  assert.equal(supportedAmount(s, contract, ch, 1, 'not_tendered'), 0);
  assert.equal(supportedAmount(s, contract, ch, 1, 'duplicate_charge'), 1100);
});
