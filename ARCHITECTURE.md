# Haulback architecture

## Purpose and boundary

Haulback is a TypeScript recovery agent plus a Go/GraphQL carrier system-of-record stand-in, sharing Postgres for durable state. The Go service exists so the agent can be developed, deployed, and measured against a deterministic carrier world without access to a real shipper account.

In production, the Go ledger is replaced by adapters to carrier invoice/tracking/claim systems, a TMS/ERP, and signed contract data. The reusable core is:

- deterministic rating and supported-amount calculation;
- deadline/expected-value triage;
- evidence-bundle selection and outcome learning;
- code-enforced claim policy;
- one bounded appeal;
- approved-versus-posted credit reconciliation;
- human queue and operator controls;
- run/decision/model telemetry;
- seeded evaluation against explicit baselines.

The system deliberately does **not** claim that simulator recovery is real-world recovery.

## Component map

| Component | Technology | Responsibility |
|---|---|---|
| Control Room | TypeScript HTTP server, server-rendered HTML | Operator views, Run/Pause, settings, manual review, holds, credit actions |
| Sweep | TypeScript CLI invoked by GitHub Actions/Cloud Scheduler | Locked unattended audit/claim/reconcile run |
| Rating engine | `src/rating.ts` | Re-prices charges and emits category-specific supported findings |
| Strategy | `src/strategy.ts` | Evidence bundles, expected net value, exploration, deadline-first sort |
| Drafting | `src/draft.ts`, `src/models.ts` | Baseline templates or optional structured model tool calls |
| Policy gate | `src/policy.ts`, `policy/claims.json` | Final code permission for every carrier-facing claim |
| Engine | `src/engine.ts` | Outcome sync, credit reconciliation, task construction, filing, appeals |
| Agent memory | Postgres schema `haulback` | Runs, decisions, model calls, trials, stats, queue, settings, holds |
| Carrier stand-in | Go + GraphQL in `ledger/` | Contracts, shipments, charges, claim adjudication, credit posting, events |
| Ledger snapshot | Postgres schema `haulback_ledger` | One JSON world snapshot, intentionally single-writer |
| Evaluator | `src/evaluate.ts` | Guarded, isolated `none`/`simple`/`haulback` comparison |

## Core sequence

```text
Scheduler or operator
  └─ runSweep(scope)
       ├─ Postgres advisory lock (one active sweep)
       ├─ ledger /healthz
       ├─ sync decided claim outcomes into claim trials + bundle stats
       ├─ find approved credits past due day + operator grace
       │    └─ chase missing credit / queue chase failures
       ├─ fetch contracts, shipments, claims through GraphQL
       ├─ filter to invoiced shipments and enabled carriers/categories
       ├─ deterministic audit -> Finding[]
       ├─ sort: deadline urgency -> estimated net value -> deadline
       ├─ remove held, already queued, tiny, duplicate, and already-claimed work
       ├─ for each task, subject to sweep cap and model budget:
       │    ├─ baseline template or model draft_claim tool call
       │    ├─ policy gate
       │    ├─ queue human-owned cases
       │    └─ file initial claim or one appeal with an idempotency key
       ├─ optionally advance fictional carrier days (simulator only)
       ├─ sync outcomes again
       └─ persist run summary + last-sweep state
```

The dashboard uses the same engine/settings code. “Run now” bypasses only the operator’s day/time window; it does not bypass policy.

## Deterministic rating

All money is integer cents. For each shipment:

```text
dimensional_grams = ceil(length_cm × width_cm × height_cm × 1000 / dim_divisor)
billable_grams    = max(actual_grams, dimensional_grams)
billable_pounds   = ceil(billable_grams / 453.592)

base      = service_base
          + max(0, billable_pounds - 1) × per_pound
          + max(0, zone - 2) × zone_step
transport = round_half_up(base × (10,000 - discount_bps) / 10,000)
fuel      = round_half_up(transport × fuel_bps / 10,000)
fees      = contract fee only when the shipment fact says it applies
expected  = transport + fuel + applicable fees
```

If the shipment was not tendered, expected charges are zero.

Each charge is then tested independently for nine claim categories. A `Finding` carries the shipment, contract, charge, category, supported cents, expected charge, deadline, and explanation. Category logic is intentionally narrow:

- a second charge can support `duplicate_charge` for its whole total;
- only the first charge can support `not_tendered`;
- late-delivery recovery requires a guaranteed service, tender, actual late delivery, and no guarantee suspension;
- rate/weight/zone separates transport plus contract fuel on billed transport from expected transport plus expected fuel;
- fuel isolates excess above contract fuel on the billed transport amount;
- fee categories claim only the excess over the applicable expected fee.

In the fictional contracts, deadlines are `invoiceDay + category window`. A production adapter must implement each carrier’s real anchor (invoice date, scheduled-delivery date, ship date, and service-specific exception rules) rather than reuse this simplified anchor.

## Evidence bundles and learning

A learning segment is `(carrier, claim category)`. Four lawful bundles are available:

| Bundle | Evidence identifiers | Evaluator prep cost |
|---|---|---:|
| `lean` | invoice lines | $0.25 |
| `contract_first` | contract rate, invoice lines, calculation | $0.60 |
| `operations_pack` | invoice/calculation plus category-specific tracking, delivery, scale/dimension, address, or tender proof | $1.10 |
| `full_evidence` | all available contract, invoice, calculation, and operational identifiers | $1.75 |

The current evidence values are identifiers into the stand-in’s structured records, not uploaded documents. Production evidence should be immutable document/extract references with hashes, source timestamps, and retention metadata.

Bundle choice uses smoothed expected value:

```text
smoothed_win_rate = (wins + 1) / (attempts + 3)
estimated_net     = smoothed_win_rate × supported_amount - bundle_prep_cost
```

Selection rules:

1. give each enabled, untried bundle a first test in that segment;
2. otherwise use the operator’s exploration percentage (default 15%) for a seeded random enabled bundle;
3. otherwise choose the highest estimated net value.

A claim trial is written before its outcome is known. Outcome sync resolves it once:

- `approved` and `credited` both count as a bundle win exactly once;
- `denied` counts as a loss;
- aggregate attempts, wins, filed cents, and approved cents update `bundle_stats`.

Approval is the learning reward because it measures whether the evidence persuaded the carrier. Cash completion is tracked separately by credit reconciliation; a bundle is not credited twice when an approved claim later posts.

For an appeal, denial text can redirect the next bundle (for example toward contract-first or operations evidence). The parent must be denied, the recalculated amount must still match, and policy allows at most one appeal. A second denial becomes human-owned work.

## Policy gate

The optional model has a narrow structured tool:

```json
{
  "action": "wait | file_claim | appeal_claim | chase_credit | escalate",
  "bundle": "lean | contract_first | operations_pack | full_evidence",
  "message": "carrier-facing words",
  "why": "operator-visible reason"
}
```

There is no amount field. The engine always files `Finding.amountCents`.

Before a write, `gateClaim` checks:

- draft shape and enabled bundle;
- banned/threatening language;
- operator minimum claim and tolerance;
- deadline for automatic initial claims;
- human approval for ambiguous contracts and amounts above threshold;
- exact duplicate/active/successful claim state;
- appeal parent, amount continuity, and appeal cap;
- evidence availability.

Known human-owned cases use the deterministic template path instead of spending a model call. Malformed or unavailable model output becomes a queue item, not a guessed carrier message. Model calls and failures are recorded with tokens, cost estimate, and latency.

Free-text shipment/denial content is marked untrusted in the prompt and enclosed as data. More importantly, it has no path to alter amount, deadline, evidence availability, category, or gate settings; prompt-injection tests verify that injected threats/amount-changing language do not become permissible drafts.

## Claim and credit state machines

Initial/appeal claim:

```text
Finding
  ├─ wait/skip ───────────────► no carrier write
  ├─ queued ── human approve ─► re-rate + full gate ─► submitted
  │          ├─ hold shipment
  │          └─ close without filing
  └─ gate pass ───────────────► submitted
                                  ├─ denied ─► one appeal ─► submitted
                                  │                              ├─ denied ─► human
                                  │                              └─ approved
                                  └─ approved ─► credited
```

Credit reconciliation:

```text
approved
  ├─ credit posts by due day ─────────────► credited
  ├─ world day <= due day + grace ────────► keep waiting
  └─ world day > due day + grace ─────────► chase
                                              ├─ posts later ─► credited
                                              └─ chase error ─► Needs you
```

The fictional carrier decides claims 1–3 days after filing. Approved credits are due 3–6 days after approval. A deterministic minority of credits are hidden as “stuck” and post only after a chase followed by a later day advance. Those behaviours are evaluator mechanics, not claims about any real carrier.

Operators can manually chase an approved claim or mark it posted after seeing it on a bill. In production, “mark posted” should require a credit-memo/invoice source reference and should normally be driven by the invoice feed, not a bare assertion.

## GraphQL surface

Queries:

- `stats`
- `contracts`
- `shipments(limit)`
- `shipment(id)`
- `claims(shipmentId, limit)`
- `events(afterId, shipmentId, limit)`

Mutations:

- `fileClaim(...)`
- `appealClaim(...)`
- `chaseCredit(claimId)`
- `markCreditPosted(claimId)`
- `createShipment(...)`
- `advanceDay`
- `resetWorld(seed)` — evaluator/sandbox only

`/healthz` is public. `/graphql` requires `Authorization: Bearer <LEDGER_TOKEN>` whenever a token is configured. Hidden adjudication preferences and validity labels are not schema fields.

The TypeScript client requires the full `LEDGER_URL`, ending in `/graphql`; health is derived by replacing that suffix with `/healthz`.

## Idempotency and concurrency

Three independent brakes prevent duplicate work:

1. **Sweep lock:** Postgres advisory lock `812733` allows one sweep/day-advance path at a time. A contending run reports that it was skipped.
2. **Policy duplicate check:** shipment + charge + category + stage state is inspected before filing.
3. **Ledger idempotency key:** `scope:shipmentId:chargeId:category:stage`. Re-submitting the same key returns the original claim.

The Go service also serializes state access with a mutex and persists one snapshot. It must run as **one authoritative ledger process**. Multiple ledger replicas would be unsafe for this snapshot design; the Render/GCP configuration therefore treats it as a singleton. The TypeScript dashboard can be restarted independently because its durable state is in Postgres.

Claim-trial outcome resolution is guarded by `outcome='pending'`, so calling sync repeatedly cannot double-count a bundle result.

## Postgres data model

Schema `haulback`:

| Table | Contents |
|---|---|
| `runs` | Sweep/manual/eval run type, model, scope, note, start/finish, JSON stats/error |
| `calls` | Model stage/spec, entity IDs, tokens, estimated cost, latency, error |
| `decisions` | Shipment/charge/carrier/category/bundle/action/outcome/reason audit trail |
| `queue` | Open/resolved human cases with reason, JSON detail, resolution |
| `state` | Current settings and last-sweep state by scoped key |
| `settings_history` | Immutable operator-settings snapshots and actor label |
| `claim_trials` | One row per submitted claim used for learning attribution |
| `bundle_stats` | Aggregated attempts/wins/filed/approved cents by segment and bundle |
| `suppressions` | Operator holds that stop automatic work for a shipment |

Scopes isolate live work (`live`) from evaluator modes (`eval-none`, `eval-simple`, `eval-haulback`). Resetting an evaluation scope never needs to touch live rows, but the evaluator still must use a throwaway database/world in the supplied workflows.

Schema `haulback_ledger` contains the Go stand-in’s single-row JSON snapshot. Sharing one database is convenient for the free deployment; separate databases are also supported by giving each process its own `DATABASE_URL`.

## Settings model

Settings are operator data, normalized on every save:

- enabled/pause;
- timezone, days, start/end window;
- minimum claim, tolerance, human threshold;
- maximum claim actions per sweep;
- approved-credit grace days;
- appeals on/off;
- enabled carriers, categories, and bundles;
- exploration percentage (0–50);
- draft model and per-sweep model budget (0–100 USD);
- bundle tones and message templates.

Hard bounds and banned-template checks run server-side. Settings cannot change supported-amount math, evidence requirements, duplicate rules, appeal cap, or banned language. Every save writes history.

Recommended starting point is Balanced:

```text
ON, every day, 00:00–23:59 Asia/Karachi
minimum claim $2.00, tolerance $0.25
human approval above $250
max 60 new claim actions/sweep
chase 5 days after credit due day
automatic appeal ON
all carriers/categories/bundles ON
15% exploration
baseline:rules, $1 model budget
```

## Evaluator design

`src/evaluate.ts` refuses to run unless `HAULBACK_EVAL_CONFIRM=reset-world`. For each mode it:

1. resets the target fictional world to the same seed;
2. resets only that mode’s agent scope;
3. writes evaluation settings;
4. runs a daily engine cycle and advances one carrier day;
5. syncs outcomes;
6. reads final ledger truth and writes JSON + Markdown reports.

Modes:

- `none`: audits may be observed, but files nothing;
- `simple`: same deterministic findings, always `lean`, no appeals, effectively no credit chasing;
- `haulback`: strategy, learning, appeals, and reconciliation enabled.

Metrics distinguish:

- supported pool;
- approved, credited, and approved-but-uncredited cents;
- recovery rate;
- initial claims, appeals, chases;
- valid/invalid attempts and true claim precision;
- approval rate;
- missed deadlines;
- handling assumptions, model cost, and net credited value.

Because the evaluator resets a world, both the local instructions and GitHub workflow point it only at an in-memory ledger and throwaway Postgres service.

## Failure handling

| Failure | Behaviour |
|---|---|
| Ledger sleeping/unreachable | Health check fails; dashboard shows a carrier-connection page; sweep exits without filing |
| Wrong ledger token | GraphQL returns 401; no silent fallback or partial claim write |
| Invalid persisted settings | Loader falls back to defaults rather than executing unbounded values |
| Unsafe settings save | Validation rejects the whole save; previous settings remain effective |
| Model timeout/malformed tool call | Bounded retries, telemetry, then human queue |
| Model budget exceeded | Sweep sets `budgetStopped` and stops processing further claim tasks |
| Carrier write error | Decision recorded as failed; no claim trial is treated as a win |
| Credit-chase error | Open `credit_missing` queue item with claim context |
| Duplicate dashboard submit | Policy returns wait/duplicate reason and ledger idempotency returns the original claim if reached |
| Ledger snapshot unavailable/corrupt | Go startup/read fails closed rather than inventing a new world, except first creation when no snapshot row exists |
| Dashboard in production without password | Health remains public; all operator routes return 401 |
| Overlapping schedule/manual sweeps | Advisory lock skips the contender and records no duplicate actions |

## Security model

- Dashboard: HTTP Basic auth using `DASHBOARD_USER` (default `operator`) and `REVIEW_PASSWORD`, compared in constant time. Production mode fails closed when no password is set. This is suitable for the single-operator portfolio deployment, not a substitute for SSO/RBAC in a multi-user production rollout.
- Ledger: bearer token on every GraphQL request. Health exposes only `ok`.
- Secrets live in Render/GitHub/cloud secret stores; examples contain blanks only.
- Model input includes shipment facts needed for drafting, but untrusted notes/denials cannot alter code-owned fields.
- Dashboard output escapes user/world text before embedding it in HTML.
- Manual claim approval re-runs fresh rating and the policy gate; approving the human reason is not permission to raise an amount.

## Scale limits and production hardening

The current implementation is intentionally legible rather than prematurely distributed:

- each sweep fetches up to 1,000 shipments/claims/events and audits them in memory;
- the Go stand-in loads/saves a whole JSON snapshot under a mutex;
- TypeScript and Go rating logic are parallel implementations kept aligned by tests and the evaluator;
- evidence is represented by identifiers rather than a document vault;
- chase scheduling is day-based and can repeat while a credit remains approved;
- one global sweep lock is correct for one shipper/scope, not a multi-tenant scheduler.

A production scale path would:

1. ingest invoice/tracking deltas with durable cursors and partition by shipper/carrier/account;
2. store shipments/charges/claims relationally with source-system IDs and effective-dated contracts;
3. generate TS/Go rating test vectors from one contract fixture set, or make one rating service authoritative;
4. attach evidence documents/extracts by immutable hash and retention policy;
5. add per-carrier claim adapters with rate limits, retries, and portal/API idempotency;
6. make outcome+stats updates transactional and add chase cadence/caps;
7. add SSO/RBAC, tenant isolation, audit export, alerting, and backup/restore drills.

None of those changes should weaken the central invariant: **the amount and permission come from deterministic code; a model only drafts inside that boundary.**
