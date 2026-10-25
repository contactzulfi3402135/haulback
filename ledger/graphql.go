package main

import (
	"fmt"
	"sort"
	"sync"

	"github.com/graphql-go/graphql"
)

// GraphQL surface for the carrier/shipment system of record. Hidden
// carrier adjudication preferences and per-claim validity labels are not
// fields anywhere in this schema; agents learn from outcomes.

type Service struct {
	mu    sync.Mutex
	store Store
}

func (s *Service) view(fn func(st *State)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.store.Load()
	if err != nil {
		return err
	}
	fn(st)
	return nil
}

func (s *Service) update(fn func(st *State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.store.Load()
	if err != nil {
		return err
	}
	if err := fn(st); err != nil {
		return err
	}
	return s.store.Save(st)
}

var rateType = graphql.NewObject(graphql.ObjectConfig{Name: "ServiceRate", Fields: graphql.Fields{
	"service":   &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(ServiceRate).Service, nil }},
	"baseCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(ServiceRate).BaseCents), nil }},
	"perPoundCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(ServiceRate).PerPoundCents), nil
	}},
	"zoneStepCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(ServiceRate).ZoneStepCents), nil
	}},
	"guaranteed": &graphql.Field{Type: graphql.Boolean, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(ServiceRate).Guaranteed, nil }},
}})

var contractType = graphql.NewObject(graphql.ObjectConfig{Name: "CarrierContract", Fields: graphql.Fields{
	"carrier":     &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(CarrierContract).Carrier, nil }},
	"name":        &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(CarrierContract).Name, nil }},
	"dimDivisor":  &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(CarrierContract).DimDivisor, nil }},
	"discountBps": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(CarrierContract).DiscountBps, nil }},
	"fuelBps":     &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(CarrierContract).FuelBps, nil }},
	"residentialFeeCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(CarrierContract).ResidentialFeeCents), nil
	}},
	"deliveryAreaFeeCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(CarrierContract).DeliveryAreaFeeCents), nil
	}},
	"addressCorrectionFeeCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(CarrierContract).AddressCorrectionFeeCents), nil
	}},
	"handlingFeeCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(CarrierContract).HandlingFeeCents), nil
	}},
	"serviceClaimWindowDays": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return p.Source.(CarrierContract).ServiceClaimWindowDays, nil
	}},
	"billingClaimWindowDays": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return p.Source.(CarrierContract).BillingClaimWindowDays, nil
	}},
	"rates": &graphql.Field{Type: graphql.NewList(rateType), Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(CarrierContract).Rates, nil }},
}})

var chargeType = graphql.NewObject(graphql.ObjectConfig{Name: "CarrierCharge", Fields: graphql.Fields{
	"id":             &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Charge).ID, nil }},
	"shipmentId":     &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Charge).ShipmentID, nil }},
	"invoiceId":      &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Charge).InvoiceID, nil }},
	"invoiceDay":     &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Charge).InvoiceDay, nil }},
	"transportCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Charge).TransportCents), nil }},
	"fuelCents":      &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Charge).FuelCents), nil }},
	"residentialCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(Charge).ResidentialCents), nil
	}},
	"deliveryAreaCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(Charge).DeliveryAreaCents), nil
	}},
	"addressCorrectionCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(Charge).AddressCorrectionCents), nil
	}},
	"handlingCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Charge).HandlingCents), nil }},
	"totalCents":    &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Charge).TotalCents), nil }},
}})

func nullableInt(v *int) (interface{}, error) {
	if v == nil {
		return nil, nil
	}
	return *v, nil
}

var shipmentType = graphql.NewObject(graphql.ObjectConfig{Name: "Shipment", Fields: graphql.Fields{
	"id":          &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).ID, nil }},
	"tracking":    &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Tracking, nil }},
	"carrier":     &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Carrier, nil }},
	"service":     &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Service, nil }},
	"customerRef": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).CustomerRef, nil }},
	"origin":      &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Origin, nil }},
	"destination": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Destination, nil }},
	"zone":        &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Zone, nil }},
	"billedZone":  &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).BilledZone, nil }},
	"shipDay":     &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).ShipDay, nil }},
	"invoiceDay":  &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).InvoiceDay, nil }},
	"promisedDay": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).PromisedDay, nil }},
	"deliveredDay": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return nullableInt(p.Source.(Shipment).DeliveredDay)
	}},
	"weightGrams":        &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).WeightGrams, nil }},
	"billedWeightGrams":  &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).BilledWeightGrams, nil }},
	"lengthCm":           &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).LengthCm, nil }},
	"widthCm":            &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).WidthCm, nil }},
	"heightCm":           &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).HeightCm, nil }},
	"residential":        &graphql.Field{Type: graphql.Boolean, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Residential, nil }},
	"deliveryArea":       &graphql.Field{Type: graphql.Boolean, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).DeliveryArea, nil }},
	"addressCorrected":   &graphql.Field{Type: graphql.Boolean, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).AddressCorrected, nil }},
	"handlingRequired":   &graphql.Field{Type: graphql.Boolean, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).HandlingRequired, nil }},
	"tendered":           &graphql.Field{Type: graphql.Boolean, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Tendered, nil }},
	"guaranteeSuspended": &graphql.Field{Type: graphql.Boolean, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).GuaranteeSuspended, nil }},
	"contractAmbiguous":  &graphql.Field{Type: graphql.Boolean, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).ContractAmbiguous, nil }},
	"note":               &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Note, nil }},
	"charges":            &graphql.Field{Type: graphql.NewList(chargeType), Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Shipment).Charges, nil }},
}})

var claimType = graphql.NewObject(graphql.ObjectConfig{Name: "CarrierClaim", Fields: graphql.Fields{
	"id":            &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).ID, nil }},
	"shipmentId":    &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).ShipmentID, nil }},
	"chargeId":      &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).ChargeID, nil }},
	"category":      &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).Category, nil }},
	"stage":         &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).Stage, nil }},
	"parentClaimId": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).ParentClaimID, nil }},
	"bundle":        &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).Bundle, nil }},
	"evidence":      &graphql.Field{Type: graphql.NewList(graphql.String), Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).Evidence, nil }},
	"message":       &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).Message, nil }},
	"amountCents":   &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Claim).AmountCents), nil }},
	"approvedCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Claim).ApprovedCents), nil }},
	"status":        &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).Status, nil }},
	"filedDay":      &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).FiledDay, nil }},
	"decisionDay":   &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return nullableInt(p.Source.(Claim).DecisionDay) }},
	"creditDueDay":  &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return nullableInt(p.Source.(Claim).CreditDueDay) }},
	"creditPostedDay": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return nullableInt(p.Source.(Claim).CreditPostedDay)
	}},
	"creditChasedDay": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return nullableInt(p.Source.(Claim).CreditChasedDay)
	}},
	"denialCode": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).DenialCode, nil }},
	"denialText": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Claim).DenialText, nil }},
}})

var eventType = graphql.NewObject(graphql.ObjectConfig{Name: "LedgerEvent", Fields: graphql.Fields{
	"id":         &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Event).ID), nil }},
	"shipmentId": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Event).ShipmentID, nil }},
	"claimId":    &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Event).ClaimID, nil }},
	"day":        &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Event).Day, nil }},
	"kind":       &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Event).Kind, nil }},
	"detail":     &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Event).Detail, nil }},
}})

var statsType = graphql.NewObject(graphql.ObjectConfig{Name: "CarrierStats", Fields: graphql.Fields{
	"worldDay":      &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(WorldStats).WorldDay, nil }},
	"shipmentCount": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(WorldStats).ShipmentCount, nil }},
	"invoicedShipmentCount": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return p.Source.(WorldStats).InvoicedShipmentCount, nil
	}},
	"billedCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(WorldStats).BilledCents), nil }},
	"expectedCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(WorldStats).ExpectedCents), nil
	}},
	"claimableCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(WorldStats).ClaimableCents), nil
	}},
	"creditedCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(WorldStats).CreditedCents), nil
	}},
	"approvedUncreditedCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
		return int(p.Source.(WorldStats).ApprovedUncreditedCents), nil
	}},
	"filedClaims":   &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(WorldStats).FiledClaims, nil }},
	"validClaims":   &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(WorldStats).ValidClaims, nil }},
	"invalidClaims": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(WorldStats).InvalidClaims, nil }},
	"deniedClaims":  &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(WorldStats).DeniedClaims, nil }},
	"appealClaims":  &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(WorldStats).AppealClaims, nil }},
}})

func argString(p graphql.ResolveParams, name string, fallback string) string {
	if v, ok := p.Args[name].(string); ok && v != "" {
		return v
	}
	return fallback
}
func argInt(p graphql.ResolveParams, name string, fallback int) int {
	if v, ok := p.Args[name].(int); ok {
		return v
	}
	return fallback
}
func argBool(p graphql.ResolveParams, name string, fallback bool) bool {
	if v, ok := p.Args[name].(bool); ok {
		return v
	}
	return fallback
}
func argStrings(p graphql.ResolveParams, name string) []string {
	raw, _ := p.Args[name].([]interface{})
	out := []string{}
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func buildSchema(svc *Service) (graphql.Schema, error) {
	query := graphql.NewObject(graphql.ObjectConfig{Name: "Query", Fields: graphql.Fields{
		"stats": &graphql.Field{Type: statsType, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
			var out WorldStats
			err := svc.view(func(st *State) { out = worldStats(st) })
			return out, err
		}},
		"contracts": &graphql.Field{Type: graphql.NewList(contractType), Resolve: func(p graphql.ResolveParams) (interface{}, error) {
			var out []CarrierContract
			err := svc.view(func(st *State) { out = append(out, st.Contracts...) })
			return out, err
		}},
		"shipments": &graphql.Field{
			Type: graphql.NewList(shipmentType),
			Args: graphql.FieldConfigArgument{
				"invoicedOnly": &graphql.ArgumentConfig{Type: graphql.Boolean},
				"limit":        &graphql.ArgumentConfig{Type: graphql.Int},
			},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				limit := argInt(p, "limit", 1000)
				invoicedOnly := argBool(p, "invoicedOnly", false)
				var out []Shipment
				err := svc.view(func(st *State) {
					for _, s := range st.Shipments {
						if invoicedOnly && s.InvoiceDay > st.Day {
							continue
						}
						out = append(out, s)
						if len(out) >= limit {
							break
						}
					}
				})
				return out, err
			},
		},
		"shipment": &graphql.Field{
			Type: shipmentType,
			Args: graphql.FieldConfigArgument{"id": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)}},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				var out *Shipment
				err := svc.view(func(st *State) {
					_, s := findShipment(st, argString(p, "id", ""))
					if s != nil {
						cp := *s
						out = &cp
					}
				})
				if err != nil || out == nil {
					return nil, err
				}
				return *out, nil
			},
		},
		"claims": &graphql.Field{
			Type: graphql.NewList(claimType),
			Args: graphql.FieldConfigArgument{"shipmentId": &graphql.ArgumentConfig{Type: graphql.String}, "limit": &graphql.ArgumentConfig{Type: graphql.Int}},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				shipmentID := argString(p, "shipmentId", "")
				limit := argInt(p, "limit", 1000)
				var out []Claim
				err := svc.view(func(st *State) {
					for _, c := range st.Claims {
						if shipmentID != "" && c.ShipmentID != shipmentID {
							continue
						}
						out = append(out, c)
						if len(out) >= limit {
							break
						}
					}
				})
				return out, err
			},
		},
		"events": &graphql.Field{
			Type: graphql.NewList(eventType),
			Args: graphql.FieldConfigArgument{"afterId": &graphql.ArgumentConfig{Type: graphql.Int}, "shipmentId": &graphql.ArgumentConfig{Type: graphql.String}, "limit": &graphql.ArgumentConfig{Type: graphql.Int}},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				after := int64(argInt(p, "afterId", 0))
				shipmentID := argString(p, "shipmentId", "")
				limit := argInt(p, "limit", 1000)
				var out []Event
				err := svc.view(func(st *State) {
					for _, e := range st.Events {
						if e.ID <= after || (shipmentID != "" && e.ShipmentID != shipmentID) {
							continue
						}
						out = append(out, e)
						if len(out) >= limit {
							break
						}
					}
					sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
				})
				return out, err
			},
		},
	}})

	mutation := graphql.NewObject(graphql.ObjectConfig{Name: "Mutation", Fields: graphql.Fields{
		"fileClaim": &graphql.Field{
			Type: claimType,
			Args: graphql.FieldConfigArgument{
				"shipmentId":     &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				"chargeId":       &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				"category":       &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				"amountCents":    &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.Int)},
				"bundle":         &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				"evidence":       &graphql.ArgumentConfig{Type: graphql.NewList(graphql.String)},
				"message":        &graphql.ArgumentConfig{Type: graphql.String},
				"idempotencyKey": &graphql.ArgumentConfig{Type: graphql.String},
			},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				var out Claim
				err := svc.update(func(st *State) error {
					var err error
					out, err = fileClaim(st, argString(p, "shipmentId", ""), argString(p, "chargeId", ""), argString(p, "category", ""), int64(argInt(p, "amountCents", 0)), argString(p, "bundle", ""), argStrings(p, "evidence"), argString(p, "message", ""), argString(p, "idempotencyKey", ""), "", "initial")
					return err
				})
				return out, err
			},
		},
		"appealClaim": &graphql.Field{
			Type: claimType,
			Args: graphql.FieldConfigArgument{
				"claimId":        &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				"bundle":         &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				"evidence":       &graphql.ArgumentConfig{Type: graphql.NewList(graphql.String)},
				"message":        &graphql.ArgumentConfig{Type: graphql.String},
				"idempotencyKey": &graphql.ArgumentConfig{Type: graphql.String},
			},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				var out Claim
				err := svc.update(func(st *State) error {
					_, parent := findClaim(st, argString(p, "claimId", ""))
					if parent == nil {
						return fmt.Errorf("claim not found")
					}
					if parent.Status != "denied" {
						return fmt.Errorf("only a denied claim can be appealed")
					}
					var err error
					out, err = fileClaim(st, parent.ShipmentID, parent.ChargeID, parent.Category, parent.AmountCents, argString(p, "bundle", ""), argStrings(p, "evidence"), argString(p, "message", ""), argString(p, "idempotencyKey", ""), parent.ID, "appeal")
					return err
				})
				return out, err
			},
		},
		"chaseCredit": &graphql.Field{
			Type: claimType,
			Args: graphql.FieldConfigArgument{"claimId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)}},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				var out Claim
				err := svc.update(func(st *State) error {
					_, cl := findClaim(st, argString(p, "claimId", ""))
					if cl == nil {
						return fmt.Errorf("claim not found")
					}
					if cl.Status != "approved" {
						return fmt.Errorf("only an approved uncredited claim can be chased")
					}
					day := st.Day
					cl.CreditChasedDay = &day
					out = *cl
					addEvent(st, cl.ShipmentID, cl.ID, st.Day, "credit_chased", "Requested posting of approved carrier credit.")
					return nil
				})
				return out, err
			},
		},
		"markCreditPosted": &graphql.Field{
			Type: claimType,
			Args: graphql.FieldConfigArgument{"claimId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)}},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				var out Claim
				err := svc.update(func(st *State) error {
					_, cl := findClaim(st, argString(p, "claimId", ""))
					if cl == nil {
						return fmt.Errorf("claim not found")
					}
					if cl.Status != "approved" {
						return fmt.Errorf("only an approved claim can be marked credited")
					}
					day := st.Day
					cl.CreditPostedDay = &day
					cl.Status = "credited"
					out = *cl
					addEvent(st, cl.ShipmentID, cl.ID, st.Day, "credit_posted", "Operator confirmed carrier credit posted.")
					return nil
				})
				return out, err
			},
		},
		"createShipment": &graphql.Field{
			Type: shipmentType,
			Args: graphql.FieldConfigArgument{
				"carrier": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)}, "service": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				"customerRef": &graphql.ArgumentConfig{Type: graphql.String}, "origin": &graphql.ArgumentConfig{Type: graphql.String}, "destination": &graphql.ArgumentConfig{Type: graphql.String},
				"zone": &graphql.ArgumentConfig{Type: graphql.Int}, "billedZone": &graphql.ArgumentConfig{Type: graphql.Int},
				"shipDay": &graphql.ArgumentConfig{Type: graphql.Int}, "invoiceDay": &graphql.ArgumentConfig{Type: graphql.Int}, "promisedDay": &graphql.ArgumentConfig{Type: graphql.Int}, "deliveredDay": &graphql.ArgumentConfig{Type: graphql.Int},
				"weightGrams": &graphql.ArgumentConfig{Type: graphql.Int}, "billedWeightGrams": &graphql.ArgumentConfig{Type: graphql.Int},
				"lengthCm": &graphql.ArgumentConfig{Type: graphql.Int}, "widthCm": &graphql.ArgumentConfig{Type: graphql.Int}, "heightCm": &graphql.ArgumentConfig{Type: graphql.Int},
				"residential": &graphql.ArgumentConfig{Type: graphql.Boolean}, "deliveryArea": &graphql.ArgumentConfig{Type: graphql.Boolean}, "addressCorrected": &graphql.ArgumentConfig{Type: graphql.Boolean}, "handlingRequired": &graphql.ArgumentConfig{Type: graphql.Boolean},
				"tendered": &graphql.ArgumentConfig{Type: graphql.Boolean}, "guaranteeSuspended": &graphql.ArgumentConfig{Type: graphql.Boolean}, "contractAmbiguous": &graphql.ArgumentConfig{Type: graphql.Boolean}, "note": &graphql.ArgumentConfig{Type: graphql.String},
				"transportCents": &graphql.ArgumentConfig{Type: graphql.Int}, "fuelCents": &graphql.ArgumentConfig{Type: graphql.Int}, "residentialCents": &graphql.ArgumentConfig{Type: graphql.Int}, "deliveryAreaCents": &graphql.ArgumentConfig{Type: graphql.Int}, "addressCorrectionCents": &graphql.ArgumentConfig{Type: graphql.Int}, "handlingCents": &graphql.ArgumentConfig{Type: graphql.Int},
				"duplicateCharge": &graphql.ArgumentConfig{Type: graphql.Boolean},
			},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				var out Shipment
				err := svc.update(func(st *State) error {
					carrier := argString(p, "carrier", "")
					if _, ok := contractFor(st, carrier); !ok {
						return fmt.Errorf("unknown carrier")
					}
					zone := argInt(p, "zone", 4)
					delivered := argInt(p, "deliveredDay", st.Day-1)
					s := Shipment{
						ID: fmt.Sprintf("shp-%03d", st.NextShipment), Tracking: fmt.Sprintf("HB%09d", 800000000+st.NextShipment*41),
						Carrier: carrier, Service: argString(p, "service", "ground"), CustomerRef: argString(p, "customerRef", "MANUAL-1"),
						Origin: argString(p, "origin", "Manual origin"), Destination: argString(p, "destination", "Manual destination"),
						Zone: zone, BilledZone: argInt(p, "billedZone", zone),
						ShipDay: argInt(p, "shipDay", st.Day-4), InvoiceDay: argInt(p, "invoiceDay", st.Day), PromisedDay: argInt(p, "promisedDay", st.Day-1),
						WeightGrams: argInt(p, "weightGrams", 1000), BilledWeightGrams: argInt(p, "billedWeightGrams", argInt(p, "weightGrams", 1000)),
						LengthCm: argInt(p, "lengthCm", 20), WidthCm: argInt(p, "widthCm", 15), HeightCm: argInt(p, "heightCm", 10),
						Residential: argBool(p, "residential", false), DeliveryArea: argBool(p, "deliveryArea", false),
						AddressCorrected: argBool(p, "addressCorrected", false), HandlingRequired: argBool(p, "handlingRequired", false),
						Tendered: argBool(p, "tendered", true), GuaranteeSuspended: argBool(p, "guaranteeSuspended", false),
						ContractAmbiguous: argBool(p, "contractAmbiguous", false), Note: argString(p, "note", "Manually entered shipment."),
					}
					if s.Tendered {
						s.DeliveredDay = &delivered
					}
					ch := Charge{
						ID: fmt.Sprintf("chg-%03d-a", st.NextShipment), ShipmentID: s.ID, InvoiceID: fmt.Sprintf("INV-M-%03d", st.NextShipment), InvoiceDay: s.InvoiceDay,
						TransportCents: int64(argInt(p, "transportCents", 0)), FuelCents: int64(argInt(p, "fuelCents", 0)),
						ResidentialCents: int64(argInt(p, "residentialCents", 0)), DeliveryAreaCents: int64(argInt(p, "deliveryAreaCents", 0)),
						AddressCorrectionCents: int64(argInt(p, "addressCorrectionCents", 0)), HandlingCents: int64(argInt(p, "handlingCents", 0)),
					}
					if ch.TransportCents < 0 || ch.FuelCents < 0 || ch.ResidentialCents < 0 || ch.DeliveryAreaCents < 0 || ch.AddressCorrectionCents < 0 || ch.HandlingCents < 0 {
						return fmt.Errorf("charge amounts cannot be negative")
					}
					ch.TotalCents = chargeTotal(ch)
					s.Charges = []Charge{ch}
					if argBool(p, "duplicateCharge", false) {
						dup := ch
						dup.ID = fmt.Sprintf("chg-%03d-b", st.NextShipment)
						dup.InvoiceID = ch.InvoiceID + "-DUP"
						s.Charges = append(s.Charges, dup)
					}
					st.NextShipment++
					st.Shipments = append(st.Shipments, s)
					addEvent(st, s.ID, "", st.Day, "manual_shipment", "Operator added a shipment and carrier charge.")
					out = s
					return nil
				})
				return out, err
			},
		},
		"advanceDay": &graphql.Field{
			Type: statsType,
			Args: graphql.FieldConfigArgument{"days": &graphql.ArgumentConfig{Type: graphql.Int}},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				days := argInt(p, "days", 1)
				if days < 1 || days > 31 {
					return nil, fmt.Errorf("days must be 1..31")
				}
				var out WorldStats
				err := svc.update(func(st *State) error {
					for i := 0; i < days; i++ {
						advanceDay(st)
					}
					out = worldStats(st)
					return nil
				})
				return out, err
			},
		},
		"resetWorld": &graphql.Field{
			Type: statsType,
			Args: graphql.FieldConfigArgument{"seed": &graphql.ArgumentConfig{Type: graphql.Int}},
			Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				seed := int64(argInt(p, "seed", 20261025))
				var out WorldStats
				err := svc.update(func(st *State) error {
					*st = *generateWorld(seed)
					out = worldStats(st)
					return nil
				})
				return out, err
			},
		},
	}})
	return graphql.NewSchema(graphql.SchemaConfig{Query: query, Mutation: mutation})
}
