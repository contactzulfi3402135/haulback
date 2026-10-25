package main

import "testing"

func TestResetDeterministic(t *testing.T) {
	a := generateWorld(20261025)
	b := generateWorld(20261025)
	if len(a.Shipments) != 240 || len(a.Shipments) != len(b.Shipments) {
		t.Fatalf("shipment counts differ: %d vs %d", len(a.Shipments), len(b.Shipments))
	}
	if a.Shipments[10].Charges[0].TotalCents != b.Shipments[10].Charges[0].TotalCents {
		t.Fatal("seeded charge differs between worlds")
	}
	stats := worldStats(a)
	if stats.BilledCents <= 0 || stats.ClaimableCents <= 0 {
		t.Fatalf("world needs billed and claimable money: %+v", stats)
	}
}

func fixtureShipment() (State, CarrierContract, Shipment) {
	st := State{Day: 10, Contracts: contracts(), NextClaim: 1, NextEventID: 1, CreditStuck: map[string]bool{}}
	ct, _ := contractFor(&st, "northstar")
	delivered := 5
	s := Shipment{
		ID: "shp-test", Carrier: "northstar", Service: "express", Zone: 4, BilledZone: 4,
		ShipDay: 1, PromisedDay: 3, DeliveredDay: &delivered, InvoiceDay: 7,
		WeightGrams: 1000, BilledWeightGrams: 1000, LengthCm: 20, WidthCm: 15, HeightCm: 10,
		Tendered: true,
	}
	exp := expectedFor(s, ct)
	ch := chargeFromExpected("chg-test", s, "INV-T", exp)
	s.Charges = []Charge{ch}
	st.Shipments = []Shipment{s}
	return st, ct, s
}

func TestGuaranteedLateSupportedButSuspendedIsNot(t *testing.T) {
	_, ct, s := fixtureShipment()
	got := supportedAmount(s, ct, s.Charges[0], 0, "service_guarantee")
	exp := expectedFor(s, ct)
	if got != exp.TransportCents+exp.FuelCents || got <= 0 {
		t.Fatalf("late guaranteed support=%d want %d", got, exp.TransportCents+exp.FuelCents)
	}
	s.GuaranteeSuspended = true
	if got := supportedAmount(s, ct, s.Charges[0], 0, "service_guarantee"); got != 0 {
		t.Fatalf("suspended guarantee support=%d want 0", got)
	}
}

func TestDeniedBundleCanBeAppealedAndCreditChased(t *testing.T) {
	st, ct, s := fixtureShipment()
	amount := supportedAmount(s, ct, s.Charges[0], 0, "service_guarantee")
	cl, err := fileClaim(&st, s.ID, s.Charges[0].ID, "service_guarantee", amount, "lean", []string{"invoice_lines"}, "Please refund the guaranteed service charge.", "t1", "", "initial")
	if err != nil {
		t.Fatal(err)
	}
	for st.Claims[0].Status == "submitted" {
		advanceDay(&st)
	}
	if st.Claims[0].Status != "denied" {
		t.Fatalf("lean bundle status=%s want denied", st.Claims[0].Status)
	}
	ap, err := fileClaim(&st, s.ID, s.Charges[0].ID, "service_guarantee", amount, "operations_pack", []string{"invoice_lines", "tracking_timeline", "delivery_proof"}, "Appeal with tracking proof.", "t2", cl.ID, "appeal")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 30; i++ {
		advanceDay(&st)
		_, got := findClaim(&st, ap.ID)
		if got.Status == "approved" && got.CreditChasedDay == nil {
			day := st.Day
			got.CreditChasedDay = &day
		}
		if got.Status == "credited" {
			return
		}
	}
	_, got := findClaim(&st, ap.ID)
	t.Fatalf("appeal did not reach credited: %+v", got)
}

func TestOverclaimIsInvalidAndDenied(t *testing.T) {
	st, ct, s := fixtureShipment()
	amount := supportedAmount(s, ct, s.Charges[0], 0, "service_guarantee")
	cl, err := fileClaim(&st, s.ID, s.Charges[0].ID, "service_guarantee", amount+1, "operations_pack", []string{"tracking_timeline"}, "Overclaim", "over", "", "initial")
	if err != nil {
		t.Fatal(err)
	}
	if cl.Valid {
		t.Fatal("overclaim marked valid")
	}
	for st.Claims[0].Status == "submitted" {
		advanceDay(&st)
	}
	if st.Claims[0].Status != "denied" || st.Claims[0].DenialCode != "amount_not_supported" {
		t.Fatalf("overclaim result=%+v", st.Claims[0])
	}
}

func TestDuplicateChargeSupport(t *testing.T) {
	_, ct, s := fixtureShipment()
	dup := s.Charges[0]
	dup.ID = "chg-dup"
	s.Charges = append(s.Charges, dup)
	if got := supportedAmount(s, ct, dup, 1, "duplicate_charge"); got != dup.TotalCents {
		t.Fatalf("duplicate support=%d want %d", got, dup.TotalCents)
	}
	if got := supportedAmount(s, ct, s.Charges[0], 0, "duplicate_charge"); got != 0 {
		t.Fatalf("first charge duplicate support=%d want 0", got)
	}
}
