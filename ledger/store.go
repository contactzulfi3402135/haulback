package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The stand-in carrier world is small, so the ledger persists one JSON
// snapshot. This is a disclosed simulator simplification: in production
// the carrier/TMS/ERP remains the external system of record. Run exactly
// one authoritative ledger process against a snapshot.

type Store interface {
	Load() (*State, error)
	Save(st *State) error
}

type MemoryStore struct{ st *State }

func NewMemoryStore(seed int64) *MemoryStore { return &MemoryStore{st: generateWorld(seed)} }
func (m *MemoryStore) Load() (*State, error) {
	raw, _ := json.Marshal(m.st)
	var out State
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
func (m *MemoryStore) Save(st *State) error { m.st = st; return nil }

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(ctx context.Context, dsn string) (*PostgresStore, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	p := &PostgresStore{pool: pool}
	if _, err := pool.Exec(ctx, `create schema if not exists haulback_ledger`); err != nil {
		return nil, err
	}
	if _, err := pool.Exec(ctx, `create table if not exists haulback_ledger.world_state (
		id int primary key, state jsonb not null, updated_at timestamptz not null default now())`); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *PostgresStore) Load() (*State, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var raw []byte
	err := p.pool.QueryRow(ctx, `select state from haulback_ledger.world_state where id = 1`).Scan(&raw)
	if err != nil {
		seed := int64(20261025)
		if v := os.Getenv("WORLD_SEED"); v != "" {
			fmt.Sscan(v, &seed)
		}
		st := generateWorld(seed)
		if err := p.Save(st); err != nil {
			return nil, err
		}
		return st, nil
	}
	var st State
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func (p *PostgresStore) Save(st *State) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	_, err = p.pool.Exec(ctx,
		`insert into haulback_ledger.world_state (id, state) values (1, $1)
		 on conflict (id) do update set state = excluded.state, updated_at = now()`, raw)
	return err
}
