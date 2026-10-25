package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/graphql-go/handler"
)

func main() {
	var store Store
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		ps, err := NewPostgresStore(context.Background(), dsn)
		if err != nil {
			log.Fatalf("carrier ledger: postgres: %v", err)
		}
		store = ps
		log.Print("carrier ledger: using Postgres (snapshot store)")
	} else {
		seed := int64(20261025)
		if v := os.Getenv("WORLD_SEED"); v != "" {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				seed = n
			}
		}
		store = NewMemoryStore(seed)
		log.Printf("carrier ledger: using in-memory world (seed %d)", seed)
	}
	svc := &Service{store: store}
	schema, err := buildSchema(svc)
	if err != nil {
		log.Fatalf("carrier ledger: schema: %v", err)
	}
	gql := handler.New(&handler.Config{Schema: &schema})
	token := os.Getenv("LEDGER_TOKEN")
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/plain")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.Handle("/graphql", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token != "" && !strings.EqualFold(r.Header.Get("authorization"), "Bearer "+token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		gql.ServeHTTP(w, r)
	}))
	port := os.Getenv("PORT")
	if port == "" {
		port = "8090"
	}
	log.Printf("carrier ledger: listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
