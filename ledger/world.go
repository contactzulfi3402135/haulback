package main

import (
	"fmt"
	"hash/fnv"
	"math"
	"math/rand"
	"slices"
	"sort"
	"strings"
)

// Haulback's stand-in carrier/shipment world. In production this box is
// replaced by carrier invoice feeds, a TMS/order system, and contract rate
// tables. The public GraphQL surface exposes contracts, shipments, billed
// charges, claims, and events. It deliberately does not expose each
// carrier's hidden adjudication bundle preferences; the agent must learn
// those from approval/denial outcomes.

type ServiceRate struct {
	Service       string `json:"service"`
	BaseCents     int64  `json:"baseCents"`
	PerPoundCents int64  `json:"perPoundCents"`
	ZoneStepCents int64  `json:"zoneStepCents"`
	Guaranteed    bool   `json:"guaranteed"`
}

type CarrierContract struct {
	Carrier                   string        `json:"carrier"`
	Name                      string        `json:"name"`
	DimDivisor                int           `json:"dimDivisor"`
	DiscountBps               int           `json:"discountBps"`
	FuelBps                   int           `json:"fuelBps"`
	ResidentialFeeCents       int64         `json:"residentialFeeCents"`
	DeliveryAreaFeeCents      int64         `json:"deliveryAreaFeeCents"`
	AddressCorrectionFeeCents int64         `json:"addressCorrectionFeeCents"`
	HandlingFeeCents          int64         `json:"handlingFeeCents"`
	ServiceClaimWindowDays    int           `json:"serviceClaimWindowDays"`
	BillingClaimWindowDays    int           `json:"billingClaimWindowDays"`
	Rates                     []ServiceRate `json:"rates"`
}

type Charge struct {
	ID                     string `json:"id"`
	ShipmentID             string `json:"shipmentId"`
	InvoiceID              string `json:"invoiceId"`
	InvoiceDay             int    `json:"invoiceDay"`
	TransportCents         int64  `json:"transportCents"`
	FuelCents              int64  `json:"fuelCents"`
	ResidentialCents       int64  `json:"residentialCents"`
	DeliveryAreaCents      int64  `json:"deliveryAreaCents"`
	AddressCorrectionCents int64  `json:"addressCorrectionCents"`
	HandlingCents          int64  `json:"handlingCents"`
	TotalCents             int64  `json:"totalCents"`
}

type Shipment struct {
	ID                 string   `json:"id"`
	Tracking           string   `json:"tracking"`
	Carrier            string   `json:"carrier"`
	Service            string   `json:"service"`
	CustomerRef        string   `json:"customerRef"`
	Origin             string   `json:"origin"`
	Destination        string   `json:"destination"`
	Zone               int      `json:"zone"`
	BilledZone         int      `json:"billedZone"`
	ShipDay            int      `json:"shipDay"`
	InvoiceDay         int      `json:"invoiceDay"`
	PromisedDay        int      `json:"promisedDay"`
	DeliveredDay       *int     `json:"deliveredDay"`
	WeightGrams        int      `json:"weightGrams"`
	BilledWeightGrams  int      `json:"billedWeightGrams"`
	LengthCm           int      `json:"lengthCm"`
	WidthCm            int      `json:"widthCm"`
	HeightCm           int      `json:"heightCm"`
	Residential        bool     `json:"residential"`
	DeliveryArea       bool     `json:"deliveryArea"`
	AddressCorrected   bool     `json:"addressCorrected"`
	HandlingRequired   bool     `json:"handlingRequired"`
	Tendered           bool     `json:"tendered"`
	GuaranteeSuspended bool     `json:"guaranteeSuspended"`
	ContractAmbiguous  bool     `json:"contractAmbiguous"`
	Note               string   `json:"note"`
	Charges            []Charge `json:"charges"`
}

type Claim struct {
	ID              string   `json:"id"`
	ShipmentID      string   `json:"shipmentId"`
	ChargeID        string   `json:"chargeId"`
	Category        string   `json:"category"`
	Stage           string   `json:"stage"`
	ParentClaimID   string   `json:"parentClaimId"`
	Bundle          string   `json:"bundle"`
	Evidence        []string `json:"evidence"`
	Message         string   `json:"message"`
	AmountCents     int64    `json:"amountCents"`
	ApprovedCents   int64    `json:"approvedCents"`
	Status          string   `json:"status"`
	FiledDay        int      `json:"filedDay"`
	DecisionDueDay  int      `json:"decisionDueDay"`
	DecisionDay     *int     `json:"decisionDay"`
	CreditDueDay    *int     `json:"creditDueDay"`
	CreditPostedDay *int     `json:"creditPostedDay"`
	CreditChasedDay *int     `json:"creditChasedDay"`
	DenialCode      string   `json:"denialCode"`
	DenialText      string   `json:"denialText"`
	IdempotencyKey  string   `json:"idempotencyKey"`
	Valid           bool     `json:"valid"`
}

type Event struct {
	ID         int64  `json:"id"`
	ShipmentID string `json:"shipmentId"`
	ClaimID    string `json:"claimId"`
	Day        int    `json:"day"`
	Kind       string `json:"kind"`
	Detail     string `json:"detail"`
}

type State struct {
	Day          int               `json:"day"`
	Seed         int64             `json:"seed"`
	Contracts    []CarrierContract `json:"contracts"`
	Shipments    []Shipment        `json:"shipments"`
	Claims       []Claim           `json:"claims"`
	Events       []Event           `json:"events"`
	NextEventID  int64             `json:"nextEventId"`
	NextClaim    int               `json:"nextClaim"`
	NextShipment int               `json:"nextShipment"`
	CreditStuck  map[string]bool   `json:"creditStuck"`
}

func roundHalfUp(numerator, denominator int64) int64 {
	if denominator == 0 {
		return 0
	}
	if numerator >= 0 {
		return (numerator + denominator/2) / denominator
	}
	return -((-numerator + denominator/2) / denominator)
}

func ceilDiv(a, b int64) int64 {
	if b <= 0 {
		return 0
	}
	return (a + b - 1) / b
}

func rateFor(c CarrierContract, service string) (ServiceRate, bool) {
	for _, r := range c.Rates {
		if r.Service == service {
			return r, true
		}
	}
	return ServiceRate{}, false
}

func contractFor(st *State, carrier string) (CarrierContract, bool) {
	for _, c := range st.Contracts {
		if c.Carrier == carrier {
			return c, true
		}
	}
	return CarrierContract{}, false
}

func dimensionalGrams(s Shipment, c CarrierContract) int {
	volume := int64(s.LengthCm) * int64(s.WidthCm) * int64(s.HeightCm)
	return int(ceilDiv(volume*1000, int64(c.DimDivisor)))
}

func billableGrams(weight int, s Shipment, c CarrierContract) int {
	dim := dimensionalGrams(s, c)
	if weight > dim {
		return weight
	}
	return dim
}

func billablePounds(grams int) int {
	// ceil(grams / 453.592), with integer arithmetic.
	return int(ceilDiv(int64(grams)*1000, 453592))
}

func baseBeforeDiscount(rate ServiceRate, pounds int, zone int) int64 {
	if pounds < 1 {
		pounds = 1
	}
	if zone < 2 {
		zone = 2
	}
	return rate.BaseCents + int64(pounds-1)*rate.PerPoundCents + int64(zone-2)*rate.ZoneStepCents
}

func transportFor(rate ServiceRate, c CarrierContract, pounds int, zone int, discountBps int) int64 {
	before := baseBeforeDiscount(rate, pounds, zone)
	return roundHalfUp(before*int64(10000-discountBps), 10000)
}

type expectedCharge struct {
	TransportCents         int64
	FuelCents              int64
	FuelOnBilledTransport  int64
	ResidentialCents       int64
	DeliveryAreaCents      int64
	AddressCorrectionCents int64
	HandlingCents          int64
	TotalCents             int64
	BillableGrams          int
	BillablePounds         int
}

func expectedFor(s Shipment, c CarrierContract) expectedCharge {
	rate, ok := rateFor(c, s.Service)
	if !ok {
		return expectedCharge{}
	}
	grams := billableGrams(s.WeightGrams, s, c)
	pounds := billablePounds(grams)
	transport := transportFor(rate, c, pounds, s.Zone, c.DiscountBps)
	fuel := roundHalfUp(transport*int64(c.FuelBps), 10000)
	out := expectedCharge{
		TransportCents: transport,
		FuelCents:      fuel,
		BillableGrams:  grams,
		BillablePounds: pounds,
	}
	if s.Residential {
		out.ResidentialCents = c.ResidentialFeeCents
	}
	if s.DeliveryArea {
		out.DeliveryAreaCents = c.DeliveryAreaFeeCents
	}
	if s.AddressCorrected {
		out.AddressCorrectionCents = c.AddressCorrectionFeeCents
	}
	if s.HandlingRequired {
		out.HandlingCents = c.HandlingFeeCents
	}
	if !s.Tendered {
		out.TransportCents, out.FuelCents = 0, 0
		out.ResidentialCents, out.DeliveryAreaCents = 0, 0
		out.AddressCorrectionCents, out.HandlingCents = 0, 0
	}
	out.TotalCents = out.TransportCents + out.FuelCents + out.ResidentialCents + out.DeliveryAreaCents + out.AddressCorrectionCents + out.HandlingCents
	return out
}

func chargeTotal(ch Charge) int64 {
	return ch.TransportCents + ch.FuelCents + ch.ResidentialCents + ch.DeliveryAreaCents + ch.AddressCorrectionCents + ch.HandlingCents
}

func supportedAmount(s Shipment, c CarrierContract, ch Charge, chargeIndex int, category string) int64 {
	exp := expectedFor(s, c)
	switch category {
	case "duplicate_charge":
		if chargeIndex > 0 {
			return ch.TotalCents
		}
		return 0
	case "not_tendered":
		if !s.Tendered && chargeIndex == 0 {
			return ch.TotalCents
		}
		return 0
	case "service_guarantee":
		rate, ok := rateFor(c, s.Service)
		if !ok || !rate.Guaranteed || !s.Tendered || s.GuaranteeSuspended || s.DeliveredDay == nil || chargeIndex > 0 {
			return 0
		}
		if *s.DeliveredDay > s.PromisedDay {
			return exp.TransportCents + exp.FuelCents
		}
		return 0
	case "rate_weight_zone":
		if !s.Tendered || chargeIndex > 0 {
			return 0
		}
		fuelOnBilled := roundHalfUp(ch.TransportCents*int64(c.FuelBps), 10000)
		d := (ch.TransportCents + fuelOnBilled) - (exp.TransportCents + exp.FuelCents)
		if d > 0 {
			return d
		}
		return 0
	case "fuel_surcharge":
		if !s.Tendered || chargeIndex > 0 {
			return 0
		}
		fuelOnBilled := roundHalfUp(ch.TransportCents*int64(c.FuelBps), 10000)
		if ch.FuelCents > fuelOnBilled {
			return ch.FuelCents - fuelOnBilled
		}
		return 0
	case "residential_fee":
		return positive(ch.ResidentialCents - exp.ResidentialCents)
	case "delivery_area_fee":
		return positive(ch.DeliveryAreaCents - exp.DeliveryAreaCents)
	case "address_correction_fee":
		return positive(ch.AddressCorrectionCents - exp.AddressCorrectionCents)
	case "handling_fee":
		return positive(ch.HandlingCents - exp.HandlingCents)
	default:
		return 0
	}
}

func positive(v int64) int64 {
	if v > 0 {
		return v
	}
	return 0
}

func claimCategories() []string {
	return []string{
		"service_guarantee", "duplicate_charge", "not_tendered", "rate_weight_zone", "fuel_surcharge",
		"residential_fee", "delivery_area_fee", "address_correction_fee", "handling_fee",
	}
}

func claimDeadline(s Shipment, ch Charge, c CarrierContract, category string) int {
	if category == "service_guarantee" {
		return ch.InvoiceDay + c.ServiceClaimWindowDays
	}
	return ch.InvoiceDay + c.BillingClaimWindowDays
}

func acceptedBundles(carrier string, category string) []string {
	switch carrier {
	case "northstar":
		switch category {
		case "service_guarantee":
			return []string{"operations_pack", "full_evidence"}
		case "duplicate_charge", "not_tendered":
			return []string{"lean", "contract_first", "full_evidence"}
		default:
			return []string{"contract_first", "full_evidence"}
		}
	case "bluerail":
		switch category {
		case "fuel_surcharge":
			return []string{"contract_first", "full_evidence"}
		case "duplicate_charge", "not_tendered":
			return []string{"lean", "operations_pack"}
		default:
			return []string{"operations_pack", "full_evidence"}
		}
	default: // continental: concise, indexed evidence wins; bulk packs are denied.
		switch category {
		case "service_guarantee":
			return []string{"lean", "operations_pack"}
		case "duplicate_charge", "not_tendered":
			return []string{"lean"}
		default:
			return []string{"lean", "contract_first"}
		}
	}
}

func denialFor(carrier string, category string, bundle string) (string, string) {
	if carrier == "continental" && bundle == "full_evidence" {
		return "evidence_not_indexed", "Evidence pack was not indexed to the disputed charge. Resubmit a concise, charge-specific evidence set."
	}
	accepted := acceptedBundles(carrier, category)
	if slices.Contains(accepted, "contract_first") && !slices.Contains(accepted, "operations_pack") {
		return "missing_contract", "The applicable contract rate/fee page was not identified in the evidence set."
	}
	if slices.Contains(accepted, "operations_pack") && !slices.Contains(accepted, "contract_first") {
		return "missing_operations_proof", "Operational proof (scan, measured weight/dimensions, or address evidence) was not identified."
	}
	if slices.Contains(accepted, "lean") && bundle != "lean" {
		return "evidence_not_indexed", "The carrier could not match the submitted evidence to the single disputed invoice line."
	}
	return "insufficient_evidence", "Evidence did not establish the disputed charge under the carrier review rules."
}

func contracts() []CarrierContract {
	return []CarrierContract{
		{
			Carrier: "northstar", Name: "NorthStar Parcel", DimDivisor: 5000, DiscountBps: 1800, FuelBps: 1250,
			ResidentialFeeCents: 585, DeliveryAreaFeeCents: 420, AddressCorrectionFeeCents: 2100, HandlingFeeCents: 2600,
			ServiceClaimWindowDays: 15, BillingClaimWindowDays: 90,
			Rates: []ServiceRate{
				{Service: "ground", BaseCents: 820, PerPoundCents: 68, ZoneStepCents: 95, Guaranteed: false},
				{Service: "express", BaseCents: 1850, PerPoundCents: 145, ZoneStepCents: 210, Guaranteed: true},
				{Service: "priority", BaseCents: 2900, PerPoundCents: 230, ZoneStepCents: 340, Guaranteed: true},
			},
		},
		{
			Carrier: "bluerail", Name: "BlueRail Express", DimDivisor: 6000, DiscountBps: 1200, FuelBps: 1100,
			ResidentialFeeCents: 525, DeliveryAreaFeeCents: 460, AddressCorrectionFeeCents: 1950, HandlingFeeCents: 2400,
			ServiceClaimWindowDays: 15, BillingClaimWindowDays: 90,
			Rates: []ServiceRate{
				{Service: "ground", BaseCents: 760, PerPoundCents: 62, ZoneStepCents: 88, Guaranteed: false},
				{Service: "express", BaseCents: 1725, PerPoundCents: 132, ZoneStepCents: 195, Guaranteed: true},
				{Service: "priority", BaseCents: 2700, PerPoundCents: 215, ZoneStepCents: 315, Guaranteed: true},
			},
		},
		{
			Carrier: "continental", Name: "Continental Post", DimDivisor: 5000, DiscountBps: 2200, FuelBps: 1400,
			ResidentialFeeCents: 640, DeliveryAreaFeeCents: 380, AddressCorrectionFeeCents: 2250, HandlingFeeCents: 2750,
			ServiceClaimWindowDays: 15, BillingClaimWindowDays: 90,
			Rates: []ServiceRate{
				{Service: "ground", BaseCents: 880, PerPoundCents: 74, ZoneStepCents: 102, Guaranteed: false},
				{Service: "express", BaseCents: 1980, PerPoundCents: 155, ZoneStepCents: 225, Guaranteed: true},
				{Service: "priority", BaseCents: 3100, PerPoundCents: 245, ZoneStepCents: 365, Guaranteed: true},
			},
		},
	}
}

func addEvent(st *State, shipmentID string, claimID string, day int, kind string, detail string) {
	st.Events = append(st.Events, Event{ID: st.NextEventID, ShipmentID: shipmentID, ClaimID: claimID, Day: day, Kind: kind, Detail: detail})
	st.NextEventID++
}

func chargeFromExpected(id string, s Shipment, invoiceID string, exp expectedCharge) Charge {
	ch := Charge{
		ID: id, ShipmentID: s.ID, InvoiceID: invoiceID, InvoiceDay: s.InvoiceDay,
		TransportCents: exp.TransportCents, FuelCents: exp.FuelCents,
		ResidentialCents: exp.ResidentialCents, DeliveryAreaCents: exp.DeliveryAreaCents,
		AddressCorrectionCents: exp.AddressCorrectionCents, HandlingCents: exp.HandlingCents,
	}
	// A phantom/not-tendered shipment is billed as if it moved; expectedFor
	// returns zero for it, so handled by generator before calling here.
	ch.TotalCents = chargeTotal(ch)
	return ch
}

func generateWorld(seed int64) *State {
	rng := rand.New(rand.NewSource(seed))
	st := &State{
		Day: 0, Seed: seed, Contracts: contracts(), NextEventID: 1, NextClaim: 1, NextShipment: 241,
		CreditStuck: map[string]bool{},
	}
	carriers := []string{"northstar", "bluerail", "continental"}
	services := []string{"ground", "ground", "express", "priority"}
	origins := []string{"Chicago, IL", "Dallas, TX", "Atlanta, GA", "Ontario, CA", "Columbus, OH"}
	dests := []string{"Austin, TX", "Denver, CO", "Phoenix, AZ", "Seattle, WA", "Miami, FL", "Boston, MA", "Kansas City, MO", "Portland, OR"}

	for i := 1; i <= 240; i++ {
		carrier := carriers[rng.Intn(len(carriers))]
		ct, _ := contractFor(st, carrier)
		service := services[rng.Intn(len(services))]
		shipDay := -28 + rng.Intn(58) // -28..29; invoices continue landing as world advances
		transit := 1 + rng.Intn(4)
		if service == "ground" {
			transit = 2 + rng.Intn(4)
		}
		promised := shipDay + transit
		late := rng.Float64() < 0.17
		delivered := promised
		if late {
			delivered += 1 + rng.Intn(3)
		} else if rng.Float64() < 0.25 {
			delivered--
		}
		invoiceDay := delivered + 2 + rng.Intn(5)
		s := Shipment{
			ID: fmt.Sprintf("shp-%03d", i), Tracking: fmt.Sprintf("HB%09d", 700000000+i*37),
			Carrier: carrier, Service: service, CustomerRef: fmt.Sprintf("ORD-%04d", 1000+i),
			Origin: origins[rng.Intn(len(origins))], Destination: dests[rng.Intn(len(dests))],
			Zone: 2 + rng.Intn(7), ShipDay: shipDay, InvoiceDay: invoiceDay, PromisedDay: promised,
			WeightGrams: 350 + rng.Intn(12000), LengthCm: 12 + rng.Intn(55), WidthCm: 10 + rng.Intn(45), HeightCm: 5 + rng.Intn(40),
			Residential: rng.Float64() < 0.42, DeliveryArea: rng.Float64() < 0.18,
			AddressCorrected: rng.Float64() < 0.08, HandlingRequired: rng.Float64() < 0.07,
			Tendered: true, GuaranteeSuspended: rng.Float64() < 0.05,
			Note: "Standard contract terms apply.",
		}
		s.BilledZone = s.Zone
		d := delivered
		s.DeliveredDay = &d
		if rng.Float64() < 0.05 {
			s.ContractAmbiguous = true
			s.Note = "Warehouse note: a phone side-agreement may change one surcharge. Verify the signed contract before claiming."
		}
		exp := expectedFor(s, ct)
		s.BilledWeightGrams = exp.BillableGrams
		ch := chargeFromExpected(fmt.Sprintf("chg-%03d-a", i), s, fmt.Sprintf("INV-%04d", invoiceDay+100), exp)

		// One primary billing behaviour per shipment keeps the audit math
		// attributable. Real feeds can contain several; the category deltas
		// still do not overlap.
		roll := rng.Float64()
		rate, _ := rateFor(ct, service)
		switch {
		case roll < 0.34:
			// Correct bill.
		case roll < 0.43:
			// Carrier billed a heavier weight.
			s.BilledWeightGrams = int(math.Ceil(float64(exp.BillableGrams) * (1.25 + rng.Float64()*0.5)))
			pounds := billablePounds(billableGrams(s.BilledWeightGrams, s, ct))
			ch.TransportCents = transportFor(rate, ct, pounds, s.BilledZone, ct.DiscountBps)
			ch.FuelCents = roundHalfUp(ch.TransportCents*int64(ct.FuelBps), 10000)
		case roll < 0.50:
			if s.BilledZone < 8 {
				s.BilledZone++
			}
			ch.TransportCents = transportFor(rate, ct, exp.BillablePounds, s.BilledZone, ct.DiscountBps)
			ch.FuelCents = roundHalfUp(ch.TransportCents*int64(ct.FuelBps), 10000)
		case roll < 0.57:
			// Contract discount omitted.
			ch.TransportCents = transportFor(rate, ct, exp.BillablePounds, s.Zone, 0)
			ch.FuelCents = roundHalfUp(ch.TransportCents*int64(ct.FuelBps), 10000)
		case roll < 0.64:
			ch.FuelCents = roundHalfUp(ch.TransportCents*int64(ct.FuelBps+350+rng.Intn(350)), 10000)
		case roll < 0.70:
			if !s.Residential {
				ch.ResidentialCents = ct.ResidentialFeeCents
			} else if !s.DeliveryArea {
				ch.DeliveryAreaCents = ct.DeliveryAreaFeeCents
			}
		case roll < 0.76:
			if !s.DeliveryArea {
				ch.DeliveryAreaCents = ct.DeliveryAreaFeeCents
			} else if !s.Residential {
				ch.ResidentialCents = ct.ResidentialFeeCents
			}
		case roll < 0.82:
			if !s.AddressCorrected {
				ch.AddressCorrectionCents = ct.AddressCorrectionFeeCents
			}
		case roll < 0.87:
			if !s.HandlingRequired {
				ch.HandlingCents = ct.HandlingFeeCents
			}
		case roll < 0.92:
			// Duplicate appended below.
		case roll < 0.96:
			// Phantom label: never tendered, but billed as if it moved.
			s.Tendered = false
			s.DeliveredDay = nil
		default:
			// Undercharge trap: no supported claim.
			ch.TransportCents = roundHalfUp(ch.TransportCents*92, 100)
			ch.FuelCents = roundHalfUp(ch.TransportCents*int64(ct.FuelBps), 10000)
		}
		ch.TotalCents = chargeTotal(ch)
		s.Charges = []Charge{ch}
		if roll >= 0.87 && roll < 0.92 {
			dup := ch
			dup.ID = fmt.Sprintf("chg-%03d-b", i)
			dup.InvoiceID = fmt.Sprintf("INV-%04d-DUP", invoiceDay+100)
			s.Charges = append(s.Charges, dup)
		}

		st.Shipments = append(st.Shipments, s)
		addEvent(st, s.ID, "", s.ShipDay, "shipment_created", fmt.Sprintf("%s %s shipment created for %s", ct.Name, service, s.CustomerRef))
		if s.Tendered {
			addEvent(st, s.ID, "", s.ShipDay, "tendered", "Origin scan recorded.")
		}
		if s.DeliveredDay != nil {
			addEvent(st, s.ID, "", *s.DeliveredDay, "delivered", fmt.Sprintf("Delivered on world day %d; promised day %d.", *s.DeliveredDay, s.PromisedDay))
		}
		addEvent(st, s.ID, "", s.InvoiceDay, "invoiced", fmt.Sprintf("Carrier invoice posted for $%.2f.", float64(ch.TotalCents)/100))
	}
	sort.Slice(st.Events, func(a, b int) bool { return st.Events[a].ID < st.Events[b].ID })
	return st
}

func findShipment(st *State, id string) (int, *Shipment) {
	for i := range st.Shipments {
		if st.Shipments[i].ID == id {
			return i, &st.Shipments[i]
		}
	}
	return -1, nil
}

func findClaim(st *State, id string) (int, *Claim) {
	for i := range st.Claims {
		if st.Claims[i].ID == id {
			return i, &st.Claims[i]
		}
	}
	return -1, nil
}

func hashString(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

func fileClaim(st *State, shipmentID string, chargeID string, category string, amountCents int64, bundle string, evidence []string, message string, idempotencyKey string, parentClaimID string, stage string) (Claim, error) {
	if idempotencyKey != "" {
		for _, c := range st.Claims {
			if c.IdempotencyKey == idempotencyKey {
				return c, nil
			}
		}
	}
	_, shp := findShipment(st, shipmentID)
	if shp == nil {
		return Claim{}, fmt.Errorf("shipment not found")
	}
	ct, ok := contractFor(st, shp.Carrier)
	if !ok {
		return Claim{}, fmt.Errorf("contract not found")
	}
	chargeIndex := -1
	var ch Charge
	for i, c := range shp.Charges {
		if c.ID == chargeID {
			chargeIndex, ch = i, c
			break
		}
	}
	if chargeIndex < 0 {
		return Claim{}, fmt.Errorf("charge not found")
	}
	if st.Day < ch.InvoiceDay {
		return Claim{}, fmt.Errorf("charge has not been invoiced yet")
	}
	deadline := claimDeadline(*shp, ch, ct, category)
	supported := supportedAmount(*shp, ct, ch, chargeIndex, category)
	valid := supported > 0 && amountCents > 0 && amountCents <= supported && st.Day <= deadline
	if amountCents <= 0 {
		return Claim{}, fmt.Errorf("claim amount must be positive")
	}
	claim := Claim{
		ID: fmt.Sprintf("clm-%04d", st.NextClaim), ShipmentID: shipmentID, ChargeID: chargeID,
		Category: category, Stage: stage, ParentClaimID: parentClaimID, Bundle: bundle,
		Evidence: append([]string{}, evidence...), Message: strings.TrimSpace(message),
		AmountCents: amountCents, Status: "submitted", FiledDay: st.Day,
		DecisionDueDay: st.Day + 1 + int(hashString(shipmentID+category+bundle+stage)%3),
		IdempotencyKey: idempotencyKey, Valid: valid,
	}
	// About one in five valid approvals gets a stuck credit until chased.
	st.CreditStuck[claim.ID] = hashString(claim.ID+shipmentID)%100 < 18
	st.NextClaim++
	st.Claims = append(st.Claims, claim)
	addEvent(st, shipmentID, claim.ID, st.Day, "claim_filed", fmt.Sprintf("%s claim filed for $%.2f with %s evidence.", category, float64(amountCents)/100, bundle))
	return claim, nil
}

func adjudicate(st *State, cl *Claim) {
	_, shp := findShipment(st, cl.ShipmentID)
	day := st.Day
	cl.DecisionDay = &day
	if shp == nil {
		cl.Status = "denied"
		cl.DenialCode = "shipment_not_found"
		cl.DenialText = "Shipment could not be located."
		return
	}
	ct, _ := contractFor(st, shp.Carrier)
	chargeIndex := -1
	var ch Charge
	for i, c := range shp.Charges {
		if c.ID == cl.ChargeID {
			chargeIndex, ch = i, c
		}
	}
	deadline := claimDeadline(*shp, ch, ct, cl.Category)
	supported := int64(0)
	if chargeIndex >= 0 {
		supported = supportedAmount(*shp, ct, ch, chargeIndex, cl.Category)
	}
	if cl.FiledDay > deadline {
		cl.Status = "denied"
		cl.DenialCode = "outside_window"
		cl.DenialText = fmt.Sprintf("Claim was filed after the day-%d deadline.", deadline)
		addEvent(st, cl.ShipmentID, cl.ID, st.Day, "claim_denied", cl.DenialText)
		return
	}
	if supported <= 0 || cl.AmountCents > supported {
		cl.Status = "denied"
		cl.DenialCode = "amount_not_supported"
		cl.DenialText = "Recalculation does not support the requested amount for this charge/category."
		addEvent(st, cl.ShipmentID, cl.ID, st.Day, "claim_denied", cl.DenialText)
		return
	}
	if !slices.Contains(acceptedBundles(shp.Carrier, cl.Category), cl.Bundle) {
		code, text := denialFor(shp.Carrier, cl.Category, cl.Bundle)
		cl.Status = "denied"
		cl.DenialCode = code
		cl.DenialText = text
		addEvent(st, cl.ShipmentID, cl.ID, st.Day, "claim_denied", text)
		return
	}
	cl.Status = "approved"
	cl.ApprovedCents = cl.AmountCents
	due := st.Day + 3 + int(hashString(cl.ID+"credit")%4)
	cl.CreditDueDay = &due
	addEvent(st, cl.ShipmentID, cl.ID, st.Day, "claim_approved", fmt.Sprintf("Carrier approved $%.2f; credit due by world day %d.", float64(cl.ApprovedCents)/100, due))
}

func advanceDay(st *State) {
	st.Day++
	for i := range st.Claims {
		cl := &st.Claims[i]
		if cl.Status == "submitted" && st.Day >= cl.DecisionDueDay {
			adjudicate(st, cl)
		}
	}
	for i := range st.Claims {
		cl := &st.Claims[i]
		if cl.Status != "approved" || cl.CreditPostedDay != nil || cl.CreditDueDay == nil || st.Day < *cl.CreditDueDay {
			continue
		}
		if st.CreditStuck[cl.ID] && (cl.CreditChasedDay == nil || st.Day <= *cl.CreditChasedDay) {
			continue
		}
		day := st.Day
		cl.CreditPostedDay = &day
		cl.Status = "credited"
		addEvent(st, cl.ShipmentID, cl.ID, st.Day, "credit_posted", fmt.Sprintf("Carrier credit posted for $%.2f.", float64(cl.ApprovedCents)/100))
	}
}

type WorldStats struct {
	WorldDay                int
	ShipmentCount           int
	InvoicedShipmentCount   int
	BilledCents             int64
	ExpectedCents           int64
	ClaimableCents          int64
	CreditedCents           int64
	ApprovedUncreditedCents int64
	FiledClaims             int
	ValidClaims             int
	InvalidClaims           int
	DeniedClaims            int
	AppealClaims            int
}

func worldStats(st *State) WorldStats {
	out := WorldStats{WorldDay: st.Day, ShipmentCount: len(st.Shipments), FiledClaims: len(st.Claims)}
	for _, s := range st.Shipments {
		ct, _ := contractFor(st, s.Carrier)
		exp := expectedFor(s, ct)
		invoiced := false
		for i, ch := range s.Charges {
			if ch.InvoiceDay > st.Day {
				continue
			}
			invoiced = true
			out.BilledCents += ch.TotalCents
			if i == 0 {
				out.ExpectedCents += exp.TotalCents
			}
			for _, cat := range claimCategories() {
				out.ClaimableCents += supportedAmount(s, ct, ch, i, cat)
			}
		}
		if invoiced {
			out.InvoicedShipmentCount++
		}
	}
	for _, cl := range st.Claims {
		if cl.Valid {
			out.ValidClaims++
		} else {
			out.InvalidClaims++
		}
		if cl.Status == "denied" {
			out.DeniedClaims++
		}
		if cl.Stage == "appeal" {
			out.AppealClaims++
		}
		if cl.CreditPostedDay != nil {
			out.CreditedCents += cl.ApprovedCents
		} else if cl.Status == "approved" {
			out.ApprovedUncreditedCents += cl.ApprovedCents
		}
	}
	return out
}
