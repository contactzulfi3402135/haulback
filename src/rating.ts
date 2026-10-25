// Deterministic carrier rating and audit math. This file mirrors the
// public contract calculation in the Go stand-in world. The model never
// calculates the claimable amount; it only drafts around a Finding made
// here.

export type ServiceRate = {
  service: string;
  baseCents: number;
  perPoundCents: number;
  zoneStepCents: number;
  guaranteed: boolean;
};

export type CarrierContract = {
  carrier: string;
  name: string;
  dimDivisor: number;
  discountBps: number;
  fuelBps: number;
  residentialFeeCents: number;
  deliveryAreaFeeCents: number;
  addressCorrectionFeeCents: number;
  handlingFeeCents: number;
  serviceClaimWindowDays: number;
  billingClaimWindowDays: number;
  rates: ServiceRate[];
};

export type CarrierCharge = {
  id: string;
  shipmentId: string;
  invoiceId: string;
  invoiceDay: number;
  transportCents: number;
  fuelCents: number;
  residentialCents: number;
  deliveryAreaCents: number;
  addressCorrectionCents: number;
  handlingCents: number;
  totalCents: number;
};

export type Shipment = {
  id: string;
  tracking: string;
  carrier: string;
  service: string;
  customerRef: string;
  origin: string;
  destination: string;
  zone: number;
  billedZone: number;
  shipDay: number;
  invoiceDay: number;
  promisedDay: number;
  deliveredDay: number | null;
  weightGrams: number;
  billedWeightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  residential: boolean;
  deliveryArea: boolean;
  addressCorrected: boolean;
  handlingRequired: boolean;
  tendered: boolean;
  guaranteeSuspended: boolean;
  contractAmbiguous: boolean;
  note: string;
  charges: CarrierCharge[];
};

export const CLAIM_CATEGORIES = [
  'service_guarantee',
  'duplicate_charge',
  'not_tendered',
  'rate_weight_zone',
  'fuel_surcharge',
  'residential_fee',
  'delivery_area_fee',
  'address_correction_fee',
  'handling_fee',
] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

export type ExpectedCharge = {
  transportCents: number;
  fuelCents: number;
  residentialCents: number;
  deliveryAreaCents: number;
  addressCorrectionCents: number;
  handlingCents: number;
  totalCents: number;
  billableGrams: number;
  billablePounds: number;
  dimensionalGrams: number;
};

export type Finding = {
  shipment: Shipment;
  contract: CarrierContract;
  charge: CarrierCharge;
  chargeIndex: number;
  category: ClaimCategory;
  amountCents: number;
  expected: ExpectedCharge;
  deadlineDay: number;
  explanation: string;
};

function roundHalfUp(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.sign(numerator) * Math.floor((Math.abs(numerator) + denominator / 2) / denominator);
}
function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

export function rateFor(contract: CarrierContract, service: string): ServiceRate | null {
  return contract.rates.find((r) => r.service === service) ?? null;
}

export function dimensionalGrams(s: Shipment, c: CarrierContract): number {
  return ceilDiv(s.lengthCm * s.widthCm * s.heightCm * 1000, c.dimDivisor);
}

export function billablePounds(grams: number): number {
  return ceilDiv(grams * 1000, 453592);
}

export function expectedFor(s: Shipment, c: CarrierContract): ExpectedCharge {
  const rate = rateFor(c, s.service);
  const dim = dimensionalGrams(s, c);
  const grams = Math.max(s.weightGrams, dim);
  const pounds = billablePounds(grams);
  if (!rate) {
    return {
      transportCents: 0, fuelCents: 0, residentialCents: 0, deliveryAreaCents: 0,
      addressCorrectionCents: 0, handlingCents: 0, totalCents: 0,
      billableGrams: grams, billablePounds: pounds, dimensionalGrams: dim,
    };
  }
  const beforeDiscount = rate.baseCents + Math.max(0, pounds - 1) * rate.perPoundCents + Math.max(0, s.zone - 2) * rate.zoneStepCents;
  let transportCents = roundHalfUp(beforeDiscount * (10000 - c.discountBps), 10000);
  let fuelCents = roundHalfUp(transportCents * c.fuelBps, 10000);
  let residentialCents = s.residential ? c.residentialFeeCents : 0;
  let deliveryAreaCents = s.deliveryArea ? c.deliveryAreaFeeCents : 0;
  let addressCorrectionCents = s.addressCorrected ? c.addressCorrectionFeeCents : 0;
  let handlingCents = s.handlingRequired ? c.handlingFeeCents : 0;
  if (!s.tendered) {
    transportCents = 0;
    fuelCents = 0;
    residentialCents = 0;
    deliveryAreaCents = 0;
    addressCorrectionCents = 0;
    handlingCents = 0;
  }
  return {
    transportCents,
    fuelCents,
    residentialCents,
    deliveryAreaCents,
    addressCorrectionCents,
    handlingCents,
    totalCents: transportCents + fuelCents + residentialCents + deliveryAreaCents + addressCorrectionCents + handlingCents,
    billableGrams: grams,
    billablePounds: pounds,
    dimensionalGrams: dim,
  };
}

export function supportedAmount(
  s: Shipment,
  c: CarrierContract,
  ch: CarrierCharge,
  chargeIndex: number,
  category: ClaimCategory,
): number {
  const exp = expectedFor(s, c);
  switch (category) {
    case 'duplicate_charge':
      return chargeIndex > 0 ? ch.totalCents : 0;
    case 'not_tendered':
      return !s.tendered && chargeIndex === 0 ? ch.totalCents : 0;
    case 'service_guarantee': {
      const rate = rateFor(c, s.service);
      if (!rate?.guaranteed || !s.tendered || s.guaranteeSuspended || s.deliveredDay === null || chargeIndex > 0) return 0;
      return s.deliveredDay > s.promisedDay ? exp.transportCents + exp.fuelCents : 0;
    }
    case 'rate_weight_zone': {
      if (!s.tendered || chargeIndex > 0) return 0;
      const fuelOnBilled = roundHalfUp(ch.transportCents * c.fuelBps, 10000);
      return Math.max(0, (ch.transportCents + fuelOnBilled) - (exp.transportCents + exp.fuelCents));
    }
    case 'fuel_surcharge': {
      if (!s.tendered || chargeIndex > 0) return 0;
      const fuelOnBilled = roundHalfUp(ch.transportCents * c.fuelBps, 10000);
      return Math.max(0, ch.fuelCents - fuelOnBilled);
    }
    case 'residential_fee':
      return Math.max(0, ch.residentialCents - exp.residentialCents);
    case 'delivery_area_fee':
      return Math.max(0, ch.deliveryAreaCents - exp.deliveryAreaCents);
    case 'address_correction_fee':
      return Math.max(0, ch.addressCorrectionCents - exp.addressCorrectionCents);
    case 'handling_fee':
      return Math.max(0, ch.handlingCents - exp.handlingCents);
  }
}

export function claimDeadline(s: Shipment, ch: CarrierCharge, c: CarrierContract, category: ClaimCategory): number {
  return ch.invoiceDay + (category === 'service_guarantee' ? c.serviceClaimWindowDays : c.billingClaimWindowDays);
}

const EXPLANATIONS: Record<ClaimCategory, string> = {
  service_guarantee: 'Guaranteed service arrived after the promised day and the guarantee was not suspended.',
  duplicate_charge: 'This is a second carrier charge for the same shipment.',
  not_tendered: 'The label was billed but the shipment was never tendered to the carrier.',
  rate_weight_zone: 'Transport recalculates lower from the contract weight, dimensions, zone, and discount.',
  fuel_surcharge: 'Fuel was charged above the contract percentage for the billed transport amount.',
  residential_fee: 'A residential fee was charged although the delivery address is commercial.',
  delivery_area_fee: 'A delivery-area fee was charged although the address is not in a delivery-area surcharge zone.',
  address_correction_fee: 'An address-correction fee was charged although no correction was needed.',
  handling_fee: 'An additional-handling fee was charged although the shipment did not require it.',
};

export function auditShipment(s: Shipment, c: CarrierContract): Finding[] {
  const exp = expectedFor(s, c);
  const out: Finding[] = [];
  s.charges.forEach((charge, chargeIndex) => {
    for (const category of CLAIM_CATEGORIES) {
      const amountCents = supportedAmount(s, c, charge, chargeIndex, category);
      if (amountCents <= 0) continue;
      out.push({
        shipment: s,
        contract: c,
        charge,
        chargeIndex,
        category,
        amountCents,
        expected: exp,
        deadlineDay: claimDeadline(s, charge, c, category),
        explanation: EXPLANATIONS[category],
      });
    }
  });
  return out;
}

export function auditShipments(shipments: Shipment[], contracts: CarrierContract[]): Finding[] {
  const byCarrier = new Map(contracts.map((c) => [c.carrier, c]));
  return shipments.flatMap((s) => {
    const c = byCarrier.get(s.carrier);
    return c ? auditShipment(s, c) : [];
  });
}
