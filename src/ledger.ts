import {
  expectedFor,
  type CarrierContract,
  type Shipment,
} from './rating.js';

// Client for the Go carrier stand-in. In production this layer is
// replaced by carrier invoice/tracking/account APIs. Haulback relies
// on these typed operations and never trusts shipment/denial notes as
// instructions.

export type CarrierClaim = {
  id: string;
  shipmentId: string;
  chargeId: string;
  category: string;
  stage: string;
  parentClaimId: string;
  status: 'submitted' | 'approved' | 'denied' | 'credited';
  amountCents: number;
  approvedCents: number;
  bundle: string;
  evidence: string[];
  message: string;
  filedDay: number;
  decisionDay: number | null;
  creditDueDay: number | null;
  creditPostedDay: number | null;
  creditChasedDay: number | null;
  denialCode: string;
  denialText: string;
};

export type LedgerStats = {
  worldDay: number;
  shipmentCount: number;
  invoicedShipmentCount: number;
  billedCents: number;
  expectedCents: number;
  claimableCents: number;
  creditedCents: number;
  approvedUncreditedCents: number;
  filedClaims: number;
  validClaims: number;
  invalidClaims: number;
  deniedClaims: number;
  appealClaims: number;
};

const URL_ = process.env.LEDGER_URL ?? 'http://localhost:8090/graphql';

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let lastError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (process.env.LEDGER_TOKEN) headers.authorization = `Bearer ${process.env.LEDGER_TOKEN}`;
      const res = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify({ query, variables }) });
      const text = await res.text();
      let body: { data?: T; errors?: { message: string }[] };
      try {
        body = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
      } catch {
        throw new Error(`ledger returned non-JSON HTTP ${res.status}: ${text.slice(0, 160)}`);
      }
      if (!res.ok) throw new Error(`ledger HTTP ${res.status}`);
      if (body.errors?.length) throw new Error(`ledger error: ${body.errors.map((e) => e.message).join('; ')}`);
      if (!body.data) throw new Error('ledger returned no data');
      return body.data;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 250));
    }
  }
  throw new Error(lastError || 'ledger request failed');
}

const CONTRACT_FIELDS = `carrier name dimDivisor discountBps fuelBps residentialFeeCents deliveryAreaFeeCents addressCorrectionFeeCents handlingFeeCents serviceClaimWindowDays billingClaimWindowDays rates { service baseCents perPoundCents zoneStepCents guaranteed }`;
const CHARGE_FIELDS = `id shipmentId invoiceId invoiceDay transportCents fuelCents residentialCents deliveryAreaCents addressCorrectionCents handlingCents totalCents`;
const SHIPMENT_FIELDS = `id tracking carrier service customerRef origin destination zone billedZone shipDay invoiceDay promisedDay deliveredDay weightGrams billedWeightGrams lengthCm widthCm heightCm residential deliveryArea addressCorrected handlingRequired tendered guaranteeSuspended contractAmbiguous note charges { ${CHARGE_FIELDS} }`;
const CLAIM_FIELDS = `id shipmentId chargeId category stage parentClaimId status amountCents approvedCents bundle evidence message filedDay decisionDay creditDueDay creditPostedDay creditChasedDay denialCode denialText`;
const STATS_FIELDS = `worldDay shipmentCount invoicedShipmentCount billedCents expectedCents claimableCents creditedCents approvedUncreditedCents filedClaims validClaims invalidClaims deniedClaims appealClaims`;

export async function ledgerHealth(): Promise<boolean> {
  try {
    const healthUrl = URL_.replace(/\/graphql$/, '/healthz');
    const res = await fetch(healthUrl);
    return res.ok;
  } catch {
    return false;
  }
}

export async function ledgerStats(): Promise<LedgerStats> {
  const d = await gql<{ stats: LedgerStats }>(`{ stats { ${STATS_FIELDS} } }`);
  return d.stats;
}

export async function listContracts(): Promise<CarrierContract[]> {
  const d = await gql<{ contracts: CarrierContract[] }>(`{ contracts { ${CONTRACT_FIELDS} } }`);
  return d.contracts;
}

export async function listShipments(): Promise<Shipment[]> {
  const d = await gql<{ shipments: Shipment[] }>(`query($limit: Int) { shipments(limit: $limit) { ${SHIPMENT_FIELDS} } }`, { limit: 1000 });
  return d.shipments;
}

export async function getShipment(id: string): Promise<Shipment | null> {
  const d = await gql<{ shipment: Shipment | null }>(`query($id: String!) { shipment(id: $id) { ${SHIPMENT_FIELDS} } }`, { id });
  return d.shipment;
}

export async function listClaims(shipmentId = ''): Promise<CarrierClaim[]> {
  const d = await gql<{ claims: CarrierClaim[] }>(
    `query($shipmentId: String, $limit: Int) { claims(shipmentId: $shipmentId, limit: $limit) { ${CLAIM_FIELDS} } }`,
    { shipmentId: shipmentId || undefined, limit: 1000 },
  );
  return d.claims;
}

export async function getClaim(id: string): Promise<CarrierClaim | null> {
  // The stand-in intentionally exposes claim lists rather than a
  // single-claim shortcut; the seeded world is small and bounded.
  const claims = await listClaims();
  return claims.find((c) => c.id === id) ?? null;
}

export async function listEvents(shipmentId = ''): Promise<any[]> {
  const d = await gql<{ events: any[] }>(
    `query($shipmentId: String, $limit: Int) { events(shipmentId: $shipmentId, limit: $limit) { id shipmentId claimId day kind detail } }`,
    { shipmentId: shipmentId || undefined, limit: 1000 },
  );
  return d.events;
}

export type FileClaimInput = {
  shipmentId: string;
  chargeId: string;
  category: string;
  amountCents: number;
  bundle: string;
  evidence: string[];
  message: string;
  idempotencyKey: string;
};

export async function fileClaim(input: FileClaimInput): Promise<CarrierClaim> {
  const d = await gql<{ fileClaim: CarrierClaim }>(
    `mutation($shipmentId: String!, $chargeId: String!, $category: String!, $amountCents: Int!, $bundle: String!, $evidence: [String], $message: String, $idempotencyKey: String) {
      fileClaim(shipmentId: $shipmentId, chargeId: $chargeId, category: $category, amountCents: $amountCents, bundle: $bundle, evidence: $evidence, message: $message, idempotencyKey: $idempotencyKey) { ${CLAIM_FIELDS} }
    }`,
    input,
  );
  return d.fileClaim;
}

export async function appealClaim(claimId: string, bundle: string, evidence: string[], message: string, idempotencyKey: string): Promise<CarrierClaim> {
  const d = await gql<{ appealClaim: CarrierClaim }>(
    `mutation($claimId: String!, $bundle: String!, $evidence: [String], $message: String, $idempotencyKey: String) {
      appealClaim(claimId: $claimId, bundle: $bundle, evidence: $evidence, message: $message, idempotencyKey: $idempotencyKey) { ${CLAIM_FIELDS} }
    }`,
    { claimId, bundle, evidence, message, idempotencyKey },
  );
  return d.appealClaim;
}

export async function chaseCredit(claimId: string, _message = '', _idempotencyKey = ''): Promise<CarrierClaim> {
  // The fake carrier records a generic posting request and the chase
  // day; a real adapter can send the policy-checked message through
  // the carrier's dispute/message API. The optional arguments keep
  // that production-facing contract explicit and tested upstream.
  void _message;
  void _idempotencyKey;
  const d = await gql<{ chaseCredit: CarrierClaim }>(
    `mutation($claimId: String!) { chaseCredit(claimId: $claimId) { ${CLAIM_FIELDS} } }`,
    { claimId },
  );
  return d.chaseCredit;
}

export async function markCreditPosted(claimId: string): Promise<CarrierClaim> {
  const d = await gql<{ markCreditPosted: CarrierClaim }>(
    `mutation($claimId: String!) { markCreditPosted(claimId: $claimId) { ${CLAIM_FIELDS} } }`,
    { claimId },
  );
  return d.markCreditPosted;
}

export type CreateShipmentInput = {
  carrier: string;
  service: string;
  customerRef: string;
  origin: string;
  destination: string;
  zone: number;
  billedZone: number;
  weightGrams: number;
  billedWeightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  shipDay: number;
  invoiceDay: number;
  promisedDay: number;
  deliveredDay: number | null;
  residential: boolean;
  deliveryArea: boolean;
  addressCorrected: boolean;
  handlingRequired: boolean;
  tendered: boolean;
  guaranteeSuspended: boolean;
  contractAmbiguous: boolean;
  note: string;
  forceError: string;
};

function roundHalfUp(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator / 2) / denominator);
}

export async function createShipment(input: CreateShipmentInput): Promise<Shipment> {
  const contract = (await listContracts()).find((c) => c.carrier === input.carrier);
  if (!contract) throw new Error(`Unknown carrier: ${input.carrier}`);

  const billedZone = input.billedZone || input.zone;
  const candidate: Shipment = {
    id: 'manual',
    tracking: 'manual',
    ...input,
    billedZone,
    billedWeightGrams: input.billedWeightGrams || input.weightGrams,
    charges: [],
  };

  // A phantom label is billed as if it moved, so price a tendered
  // copy to produce the carrier's (wrong) charge. The stored record
  // still says tendered=false, which is what makes it claimable.
  const priced = input.tendered ? candidate : { ...candidate, tendered: true };
  const expected = expectedFor(priced, contract);
  const charge = {
    transportCents: expected.transportCents,
    fuelCents: expected.fuelCents,
    residentialCents: expected.residentialCents,
    deliveryAreaCents: expected.deliveryAreaCents,
    addressCorrectionCents: expected.addressCorrectionCents,
    handlingCents: expected.handlingCents,
  };
  let billedWeightGrams = input.billedWeightGrams || expected.billableGrams;
  let finalBilledZone = billedZone;

  switch (input.forceError) {
    case 'weight_overstated':
    case 'rate_weight_zone': {
      billedWeightGrams = Math.ceil(expected.billableGrams * 1.5);
      const carrierPriced = expectedFor({ ...priced, weightGrams: billedWeightGrams, zone: finalBilledZone }, contract);
      charge.transportCents = carrierPriced.transportCents;
      charge.fuelCents = carrierPriced.fuelCents;
      break;
    }
    case 'zone_overstated': {
      finalBilledZone = Math.min(8, input.zone + 1);
      const carrierPriced = expectedFor({ ...priced, zone: finalBilledZone }, contract);
      charge.transportCents = carrierPriced.transportCents;
      charge.fuelCents = carrierPriced.fuelCents;
      break;
    }
    case 'fuel_overstated':
    case 'fuel_surcharge':
      charge.fuelCents = roundHalfUp(charge.transportCents * (contract.fuelBps + 500), 10000);
      break;
    case 'bad_residential_fee':
    case 'residential_fee':
      if (!input.residential) charge.residentialCents = contract.residentialFeeCents;
      break;
    case 'bad_delivery_area_fee':
    case 'delivery_area_fee':
      if (!input.deliveryArea) charge.deliveryAreaCents = contract.deliveryAreaFeeCents;
      break;
    case 'bad_address_correction_fee':
    case 'address_correction_fee':
      if (!input.addressCorrected) charge.addressCorrectionCents = contract.addressCorrectionFeeCents;
      break;
    case 'bad_handling_fee':
    case 'handling_fee':
      if (!input.handlingRequired) charge.handlingCents = contract.handlingFeeCents;
      break;
    default:
      break;
  }

  const variables = {
    carrier: input.carrier,
    service: input.service,
    customerRef: input.customerRef,
    origin: input.origin,
    destination: input.destination,
    zone: input.zone,
    billedZone: finalBilledZone,
    shipDay: input.shipDay,
    invoiceDay: input.invoiceDay,
    promisedDay: input.promisedDay,
    deliveredDay: input.deliveredDay,
    weightGrams: input.weightGrams,
    billedWeightGrams,
    lengthCm: input.lengthCm,
    widthCm: input.widthCm,
    heightCm: input.heightCm,
    residential: input.residential,
    deliveryArea: input.deliveryArea,
    addressCorrected: input.addressCorrected,
    handlingRequired: input.handlingRequired,
    tendered: input.tendered,
    guaranteeSuspended: input.guaranteeSuspended,
    contractAmbiguous: input.contractAmbiguous,
    note: input.note,
    ...charge,
    duplicateCharge: input.forceError === 'duplicate_charge',
  };

  const d = await gql<{ createShipment: Shipment }>(
    `mutation(
      $carrier: String!, $service: String!, $customerRef: String, $origin: String, $destination: String,
      $zone: Int, $billedZone: Int, $shipDay: Int, $invoiceDay: Int, $promisedDay: Int, $deliveredDay: Int,
      $weightGrams: Int, $billedWeightGrams: Int, $lengthCm: Int, $widthCm: Int, $heightCm: Int,
      $residential: Boolean, $deliveryArea: Boolean, $addressCorrected: Boolean, $handlingRequired: Boolean,
      $tendered: Boolean, $guaranteeSuspended: Boolean, $contractAmbiguous: Boolean, $note: String,
      $transportCents: Int, $fuelCents: Int, $residentialCents: Int, $deliveryAreaCents: Int,
      $addressCorrectionCents: Int, $handlingCents: Int, $duplicateCharge: Boolean
    ) {
      createShipment(
        carrier: $carrier, service: $service, customerRef: $customerRef, origin: $origin, destination: $destination,
        zone: $zone, billedZone: $billedZone, shipDay: $shipDay, invoiceDay: $invoiceDay,
        promisedDay: $promisedDay, deliveredDay: $deliveredDay, weightGrams: $weightGrams,
        billedWeightGrams: $billedWeightGrams, lengthCm: $lengthCm, widthCm: $widthCm, heightCm: $heightCm,
        residential: $residential, deliveryArea: $deliveryArea, addressCorrected: $addressCorrected,
        handlingRequired: $handlingRequired, tendered: $tendered, guaranteeSuspended: $guaranteeSuspended,
        contractAmbiguous: $contractAmbiguous, note: $note, transportCents: $transportCents,
        fuelCents: $fuelCents, residentialCents: $residentialCents, deliveryAreaCents: $deliveryAreaCents,
        addressCorrectionCents: $addressCorrectionCents, handlingCents: $handlingCents,
        duplicateCharge: $duplicateCharge
      ) { ${SHIPMENT_FIELDS} }
    }`,
    variables,
  );
  return d.createShipment;
}

export async function advanceDay(): Promise<LedgerStats> {
  const d = await gql<{ advanceDay: LedgerStats }>(`mutation { advanceDay { ${STATS_FIELDS} } }`);
  return d.advanceDay;
}

export async function advanceDays(days: number): Promise<LedgerStats> {
  const d = await gql<{ advanceDay: LedgerStats }>(
    `mutation($days: Int) { advanceDay(days: $days) { ${STATS_FIELDS} } }`,
    { days },
  );
  return d.advanceDay;
}

export async function resetWorld(seed: number): Promise<LedgerStats> {
  const d = await gql<{ resetWorld: LedgerStats }>(
    `mutation($seed: Int) { resetWorld(seed: $seed) { ${STATS_FIELDS} } }`,
    { seed },
  );
  return d.resetWorld;
}
