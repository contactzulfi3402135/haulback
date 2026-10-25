-- Haulback's own memory. The carrier/shipment system of record lives
-- behind the Go GraphQL stand-in (haulback_ledger); agent state is
-- scoped so evaluation episodes never pollute live behaviour.
create schema if not exists haulback;

create table if not exists haulback.runs (
  id           bigint generated always as identity primary key,
  kind         text not null,
  draft_model  text not null,
  scope        text not null default 'live',
  note         text not null default '',
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  stats        jsonb not null default '{}'::jsonb
);

create table if not exists haulback.calls (
  id            bigint generated always as identity primary key,
  run_id        bigint references haulback.runs(id),
  stage         text not null,
  model         text not null,
  entity_ids    text[] not null default '{}',
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(12,6) not null default 0,
  ms            integer not null default 0,
  error         text,
  at            timestamptz not null default now()
);
create index if not exists haulback_calls_run_idx on haulback.calls (run_id);

create table if not exists haulback.decisions (
  id          bigint generated always as identity primary key,
  run_id      bigint references haulback.runs(id),
  scope       text not null default 'live',
  shipment_id text not null,
  charge_id   text not null default '',
  world_day   integer not null,
  carrier     text not null default '',
  category    text not null default '',
  bundle      text not null default '',
  action      text not null,
  outcome     text not null,
  why         text not null,
  at          timestamptz not null default now()
);
create index if not exists haulback_decisions_shipment_idx on haulback.decisions (shipment_id, at desc);

create table if not exists haulback.queue (
  id          bigint generated always as identity primary key,
  scope       text not null default 'live',
  shipment_id text not null,
  charge_id   text not null default '',
  kind        text not null,
  why         text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  resolution  text
);
create index if not exists haulback_queue_open_idx on haulback.queue (scope, resolved_at, created_at);

create table if not exists haulback.state (
  key   text primary key,
  value text not null
);

create table if not exists haulback.settings_history (
  id         bigint generated always as identity primary key,
  scope      text not null,
  settings   jsonb not null,
  changed_by text not null default 'dashboard',
  changed_at timestamptz not null default now()
);
create index if not exists haulback_settings_history_scope_idx on haulback.settings_history (scope, changed_at desc);

-- One row per filed claim attempt. Carrier/category/bundle/amount are
-- frozen at filing time; status is updated only from carrier outcomes.
create table if not exists haulback.claim_trials (
  scope           text not null,
  claim_id        text not null,
  shipment_id     text not null,
  charge_id       text not null,
  carrier         text not null,
  category        text not null,
  bundle          text not null,
  stage           text not null,
  amount_cents    bigint not null,
  outcome         text not null default 'pending',
  recovered_cents bigint not null default 0,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  primary key (scope, claim_id)
);
create index if not exists haulback_claim_trials_shipment_idx on haulback.claim_trials (scope, shipment_id, created_at desc);

-- Learning aggregate. Wins/recovered are incremented once when a trial
-- first reaches approved/credited; denied trials add an attempt only.
create table if not exists haulback.bundle_stats (
  scope           text not null,
  carrier         text not null,
  category        text not null,
  bundle          text not null,
  attempts        integer not null default 0,
  wins            integer not null default 0,
  filed_cents     bigint not null default 0,
  recovered_cents bigint not null default 0,
  primary key (scope, carrier, category, bundle)
);

create table if not exists haulback.suppressions (
  scope      text not null,
  shipment_id text not null,
  reason     text not null,
  at         timestamptz not null default now(),
  primary key (scope, shipment_id)
);
