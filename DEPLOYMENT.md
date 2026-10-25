# Haulback deployment and first-run guide

This guide puts Haulback in a permanent cloud home using only the free, no-card route:

| Home | Service | Why it exists |
|---|---|---|
| Code | GitHub | Keeps the source, test history, evaluation reports, and hourly worker |
| Data | Neon Postgres | Remembers settings, runs, decisions, learning, queue items, and the fictional carrier world after web services sleep/restart |
| Carrier world | Render `haulback-ledger` | The Go/GraphQL stand-in for carrier contracts, shipments, charges, claims, and posted credits |
| Control Room | Render `haulback-review` | The password-protected page you open to run and supervise Haulback |
| Worker | GitHub Actions `haulback-sweep` | Runs every hour without your PC: works claims, then advances the fictional carrier clock one day |

Do the parts in order. Do not call Haulback “live” until the acceptance checklist at the end passes.

## Safety rules before clicking

1. **Never paste a secret into chat, a GitHub issue, a commit, or a screenshot.** Secrets go only into Neon, Render, or GitHub secret boxes.
2. If any service asks for card details, **stop**. Do not enter them. Report the exact service and screen heading instead.
3. The full database address, `LEDGER_TOKEN`, dashboard password, and model API keys are secrets.
4. Use `baseline:rules` first. It costs $0 and proves the full money loop before any paid model is involved.
5. Render free services sleep after inactivity. A first page load can take about a minute; that alone is not a failure.

---

# Part 1 — Put the code on GitHub

## What GitHub is

GitHub is the permanent code home. Render reads the code from it, and GitHub Actions becomes the hourly worker.

## Steps

1. Download `haulback.zip` and extract it to a new folder named `haulback`.
   - Do not put it inside the Patrol or Remit folder.
   - After extraction, the folder should directly contain `README.md`, `package.json`, `render.yaml`, `src`, and `ledger`.
2. Open <https://github.com/new>.
3. Fill the form:
   - **Repository name:** `haulback`
   - **Description:** `Carrier-overcharge recovery agent that audits shipping bills, files supported claims, learns evidence preferences, and reconciles posted credits.`
   - Choose **Public**.
   - Leave **Add a README**, **.gitignore**, and **licence** off; the ZIP already contains the project files.
4. Click **Create repository**.
5. Keep the new empty repository page open. Its address will look like:
   `https://github.com/<your-user-name>/haulback`
6. Open **GitHub Desktop**.
7. Click **File → Clone repository…**.
8. Choose the **URL** tab.
9. Paste your new repository address.
10. Choose a local parent folder where GitHub Desktop can create a fresh empty `haulback` folder.
11. Click **Clone**.
12. Open that newly cloned, empty `haulback` folder in File Explorer/Finder.
13. Copy **the contents** of the extracted ZIP folder into the cloned folder.
    - Copy contents, not an extra outer `haulback` folder.
    - Do not overwrite `.git` if your file manager shows it; the ZIP does not contain `.git`.
14. Return to GitHub Desktop. It should show many new files under **Changes**.
15. In the summary box, type:
    `Initial Haulback agent`
16. Click **Commit to main**.
17. Click **Push origin**.
18. Refresh the GitHub repository page in your browser.
19. Click **Actions**.
20. Open the newest **test** run and wait for it to finish.

## Success looks like

- The repository shows `README.md`, `ARCHITECTURE.md`, `src`, `ledger`, `results`, and `.github`.
- The **test** workflow finishes with a green check. It type-checks/tests/builds TypeScript, tests Go, and builds both Docker images.
- A red `haulback-sweep` scheduled run before Part 5 is not your final result: the required GitHub secrets do not exist yet.

---

# Part 2 — Create the Neon database

## What Neon is

Neon is the permanent memory. One Neon database can safely hold both schemas used here:

- `haulback` — agent settings, runs, decisions, learning, queue, and holds;
- `haulback_ledger` — the fictional carrier-world snapshot.

You do not create those schemas by hand. The services create them.

## Steps

1. Open <https://console.neon.tech/app/projects>.
2. Sign in.
3. Click **New Project** (the button may say **+ New Project**).
4. Name it `haulback`.
5. Keep the default Postgres version unless Neon forces a choice.
6. Choose a nearby region if asked. Singapore or Frankfurt are sensible from Pakistan; exact region does not change the application.
7. Click **Create Project**.
8. On the project page, open **Connect** or **Connection Details**.
9. Select the default database (normally `neondb`) and the owner role Neon created.
10. Choose the **direct connection**. If there is a **Connection pooling** switch, turn pooling **off** for the address you copy.
    - Haulback uses a Postgres advisory lock for sweep safety; the direct connection avoids pooler-mode surprises.
11. Copy the full connection string. It should end with `?sslmode=require` or contain `sslmode=require`.
12. Keep it only in your clipboard/password manager. You will paste it into Render twice and GitHub once.

## Success looks like

- Neon shows a project named `haulback`.
- You can reveal one full Postgres connection string beginning with `postgres://` or `postgresql://`.
- You did not send that string to anyone.

---

# Part 3 — Create the two Render services with the Blueprint

## What Render is

Render keeps two public web services reachable when your PC is off:

1. `haulback-ledger` — fake carrier office; health is public, GraphQL needs a bearer token.
2. `haulback-review` — real Haulback Control Room; health is public, every operator page needs your dashboard login.

The repository’s `render.yaml` describes both Docker services.

## Steps

1. Open <https://dashboard.render.com>.
2. Click **+ New**.
3. Click **Blueprint**.
4. Connect/select your GitHub account if Render asks.
5. Select the `haulback` repository and click **Connect**.
6. If Render asks for a Blueprint name, use `haulback`.
7. Confirm Render found `render.yaml` and shows these services:
   - `haulback-ledger`
   - `haulback-review`
8. If Render asks for card details at any point, stop and report it. Do not continue.
9. When Render prompts for unsynced environment variables, fill them as follows.

### `haulback-ledger`

| Key | Value |
|---|---|
| `DATABASE_URL` | Paste the full direct Neon connection string from Part 2 |
| `WORLD_SEED` | Keep `20261025` |
| `LEDGER_TOKEN` | No input expected; Render generates it |

### `haulback-review`

| Key | First value |
|---|---|
| `DATABASE_URL` | Paste the same full direct Neon connection string |
| `LEDGER_URL` | `https://haulback-ledger.onrender.com/graphql` |
| `LEDGER_TOKEN` | Type a temporary random word only for this first screen; you will replace it in Part 4 |
| `REVIEW_PASSWORD` | No input expected; Render generates it |
| `DASHBOARD_USER` | Keep `operator` |
| `XAI_API_KEY` | Leave blank |
| `ANTHROPIC_API_KEY` | Leave blank |
| `OPENAI_API_KEY` | Leave blank |
| `GROQ_API_KEY` | Leave blank |
| `OSS_BASE_URL` | Keep `https://api.groq.com/openai/v1` |

Why the temporary token? The dashboard asks for the ledger token before the ledger exists. Render creates the real token with the ledger; Part 4 connects them properly.

10. Click **Apply** / **Create Blueprint** (use the confirm button Render shows).
11. Wait for both services to build. Docker builds can take several minutes.
12. Open each service and copy its real public address from the service header. Do not assume the predicted ledger address if Render shows a suffix.

## Success looks like

- Render lists both `haulback-ledger` and `haulback-review`.
- Each service reaches a live/deployed state, even though the dashboard cannot talk to the ledger until Part 4.
- Opening `<your-real-ledger-address>/healthz` eventually shows:
  `ok`

---

# Part 4 — Connect the Control Room to the ledger

## What this does

The dashboard must present the exact bearer token the ledger expects. This is the “same key in both locks” step.

## Steps

1. In Render, open **haulback-ledger**.
2. Copy its real public address from the top of the service page. Example shape:
   `https://haulback-ledger.onrender.com`
3. In the same service, open **Environment**.
4. Find `LEDGER_TOKEN`.
5. Use Render’s reveal/copy control to copy it. Do not send it anywhere except the next Render field and later the GitHub secret field.
6. Open **haulback-review → Environment**.
7. Set:
   - `LEDGER_URL` = the real ledger address **plus** `/graphql`
     - Correct: `https://haulback-ledger.onrender.com/graphql`
     - Wrong: `https://haulback-ledger.onrender.com`
   - `LEDGER_TOKEN` = the exact value copied from `haulback-ledger`
   - `DATABASE_URL` = the same direct Neon connection string
   - `DASHBOARD_USER` = `operator`
   - `NODE_ENV` = `production`
8. Click **Save Changes**.
9. If Render does not start a deploy automatically, click **Manual Deploy → Deploy latest commit**.
10. Wait for `haulback-review` to finish deploying.
11. In **haulback-review → Environment**, reveal `REVIEW_PASSWORD` only long enough to save it in your password manager.

## First public checks

Open these addresses, replacing the hosts with your real Render hosts:

1. `https://<haulback-ledger-host>/healthz`
   - Success: `ok`
2. `https://<haulback-review-host>/healthz`
   - Success: `ok`
3. `https://<haulback-review-host>/`
   - Success before login: the browser asks for a username/password; no shipment data is shown.
   - Username: `operator`
   - Password: the `REVIEW_PASSWORD` value from Render.
   - Success after login: Haulback Home opens and shows carrier world day, billed shipments, and money cards.

If Home says the carrier ledger is unavailable, wait 60 seconds and refresh once. If it still fails, check the `/graphql` suffix and token match before changing anything else.

---

# Part 5 — Add the GitHub worker secrets

## What this does

GitHub Actions is the unattended worker. It needs the same database and ledger key as Render, stored as repository secrets.

## Steps

1. Open your GitHub `haulback` repository.
2. Click **Settings**.
3. In the left sidebar, click **Secrets and variables → Actions**.
4. Click **New repository secret**.
5. Add these three secrets one at a time:

| Secret name | Value |
|---|---|
| `DATABASE_URL` | The same direct Neon connection string |
| `LEDGER_URL` | Real ledger address ending in `/graphql` |
| `LEDGER_TOKEN` | Exact token from Render `haulback-ledger` |

6. Do not add model-provider keys yet. `baseline:rules` needs none.

## Success looks like

The Actions secrets page lists all three names. GitHub will not show the values again; that is expected.

---

# Part 6 — Save the first recommended Controls

## Why this matters

Controls are stored in Postgres and used by both the dashboard and GitHub worker. Balanced settings are the safe starting point.

## Steps

1. Open the Control Room and click **Controls**.
2. Click **Balanced — recommended**, or confirm these exact values:

| Control | Value |
|---|---|
| Agent is ON | Checked |
| Timezone | `Asia/Karachi` |
| Working days | Sunday through Saturday, all checked |
| Start / End | `00:00` / `23:59` |
| Minimum claim | `2.00` |
| Ignore tiny differences up to | `0.25` |
| Ask me above | `250.00` |
| Max new claim actions per sweep | `60` |
| Wait before chasing approved credit | `5` days |
| Allow one automatic appeal | Checked |
| Carriers | NorthStar, BlueRail, Continental all on |
| Mistake types | All on |
| Proof packs | All four on |
| Testing new proof packs | `15%` |
| Drafting engine | `baseline:rules` |
| Stop sweep after model spend | `1` |
| Tones/templates | Leave defaults |

3. Scroll to the sticky action bar and click **Save controls**.
4. If you ever make a mess, **Restore balanced defaults** writes these values back and saves them.

## Success looks like

A green confirmation says the controls were saved, with Agent ON, minimum claim `$2.00`, and human approval above `$250.00`.

---

# Part 7 — Run the first manual cloud sweep

## What this proves

This proves GitHub can reach Neon and the deployed ledger, the secrets match, and the worker can act without your PC.

## Steps

1. In GitHub, open **Actions**.
2. In the workflow list, click **haulback-sweep**.
3. Click **Run workflow**.
4. Use:
   - Branch: `main`
   - Draft model: leave blank
   - Force schedule: unchecked
   - Simulator days to advance: `1`
5. Click **Run workflow**.
6. Open the new run and wait.
   - “Wake the deployed ledger” may retry while Render wakes.
   - “Run one Haulback sweep” should print `sweep complete` and run/claim statistics.

## Success looks like

- The workflow finishes green.
- Control Room **Activity → Runs** contains the new sweep.
- Home’s carrier world day advanced by one after the sweep.
- Claims/queue counts may change. A run with zero new claims can still be healthy if its log shows it audited shipments and gives a reason for each wait/skip.

---

# Part 8 — Learn the daily operating loop

## The two clocks

Do not mix these up:

- **Real clock:** GitHub runs once per real hour at minute `:37`.
- **Pretend carrier clock:** each scheduled sweep advances the fictional world by one carrier day after acting. Carrier decisions take 1–3 carrier days; approved credits are due 3–6 carrier days after approval; Haulback waits your 5-day grace before chasing.

## A good first session

1. **Home:** note the carrier world day and “Money to save first.”
2. Press **Run Haulback now**. Success is a message such as “Run finished: X new claims, Y appeals, Z credit chases…”
3. Open **Claims**. New work should be `submitted`.
4. Press **Carrier clock +1 day** a few times. Claims move to `approved` or `denied`.
5. Run Haulback again. Denied supported claims can receive their one appeal.
6. Advance more carrier days and run again. Approved claims move to `credited`, or Haulback chases them after due day + 5 grace days.
7. Open **Needs you** whenever its count is not zero. Approve only after reading the human reason and exact message; otherwise hold or close the case.
8. Open **What works** after several decisions. Judge bundles by decided attempts and net money, not one lucky win.
9. Open **Activity** to inspect exactly why a decision, queue item, or model call happened.

## Try your own cases

On **Shipments → Add test shipment**, create one story at a time:

- clean bill;
- guaranteed delivery arrives late;
- carrier uses heavier weight;
- carrier bills twice;
- wrong home-delivery fee;
- billed but never shipped;
- possible side agreement.

After creating it, inspect “Carrier billed” versus “Contract says,” run Haulback, and follow the case. The side-agreement story must land in **Needs you**, not auto-file.

## Routine operation

- Check **Needs you** first.
- Check **Claims → Approved** for promised-not-posted money.
- Let GitHub do the hourly work; use manual carrier-clock advances mainly for learning.
- Review **What works** only after enough decided claims exist in a segment.
- Keep `baseline:rules` until the full loop is understood. Add a real model later only as a measured drafting experiment.

---

# Part 9 — Optional isolated evaluation

The `haulback-eval` workflow is manual and uses a throwaway GitHub Postgres plus an in-memory ledger. It does not use your live Neon/Render world.

1. GitHub → **Actions → haulback-eval → Run workflow**.
2. Keep:
   - draft model `baseline:rules`
   - seed `20261025`
   - days `75`
3. Run it.
4. Success is a green run, a scorecard in the run summary, an uploaded `haulback-eval-results` artifact, and—when GitHub can push—a new report under `results/`.

**Never run `npm run eval` with live `DATABASE_URL`/`LEDGER_URL`.** It resets its target world.

---

# Final acceptance checklist

Haulback is only “live” when every box is honestly true:

- [ ] GitHub repository is public and contains the final commit.
- [ ] GitHub **test** workflow is green on that commit.
- [ ] Ledger public `/healthz` returns `ok`.
- [ ] Control Room public `/healthz` returns `ok`.
- [ ] Control Room `/` asks for login before showing data.
- [ ] Login with `operator` + the Render-generated password opens Home.
- [ ] Home reaches the ledger; it is not stuck on “carrier unavailable.”
- [ ] Balanced Controls are saved.
- [ ] A manual GitHub `haulback-sweep` run is green.
- [ ] A later GitHub `haulback-sweep` run whose event says **`schedule`** is green. GitHub may delay a scheduled run; a manual `workflow_dispatch` run does not replace this proof.
- [ ] Activity shows the scheduled run and its decisions.
- [ ] At least one case has been followed from finding → submitted → decided, and approved money is being reconciled toward credited.

Save the two public Render addresses and the scheduled-run link as deployment evidence. Do not save secret values in that evidence.

---

# Updating Haulback later

1. In GitHub Desktop, open the `haulback` clone and click **Fetch origin**, then **Pull origin** if needed.
2. Copy the updated project contents over the clone, without deleting `.git`.
3. Review the changed-file list.
4. Commit with a clear summary and push.
5. Wait for GitHub **test** to go green.
6. In Render, confirm both services deploy the new commit. If Auto-Deploy is off, use **Manual Deploy → Deploy latest commit** on the changed service.
7. Re-check both `/healthz` URLs and log in to the dashboard.
8. Run one manual sweep; wait for the next scheduled sweep before calling the update fully proven.

To pause immediately, open Home and click **Pause agent**, or uncheck **Agent is ON** in Controls and save. Pause stops scheduled claim actions; it does not erase history.

---

# Troubleshooting

## Render asks for a card

Stop. Do not enter card details. Report the exact Render screen and whether it happened during Blueprint creation or service creation.

## First page takes a long time

Free services sleep. Wait about a minute and refresh. The GitHub sweep also retries ledger health for up to about three minutes.

## Home says “carrier ledger unavailable”

Check, in this order:

1. Ledger `/healthz` returns `ok`.
2. `haulback-review` `LEDGER_URL` uses the real ledger host and ends `/graphql`.
3. `haulback-review` `LEDGER_TOKEN` exactly matches `haulback-ledger`.
4. Both services use the same direct Neon `DATABASE_URL` with SSL required.
5. After fixing Environment, save and redeploy `haulback-review`.

## Dashboard returns 401 / keeps asking for login

That means authentication is on. Use username `operator` and the current `REVIEW_PASSWORD` from `haulback-review → Environment`. If you change the password, save/redeploy and use the new one. A production dashboard without a password intentionally stays locked.

## Sweep says a secret is missing

Repository → **Settings → Secrets and variables → Actions**. Confirm exact names: `DATABASE_URL`, `LEDGER_URL`, `LEDGER_TOKEN`. Re-enter a mistyped secret; GitHub cannot display old values.

## Sweep says `LEDGER_URL` is wrong

It must be the full public GraphQL address, for example:
`https://haulback-ledger.onrender.com/graphql`

## No new claims

Check Controls: Agent ON, current day/time inside the schedule, carrier/category enabled, minimum/tolerance not too high, sweep cap not exhausted. Then use Home → **Run Haulback now** once for a forced-schedule test. Policy still applies.

## Claims stay submitted

The fictional carrier decides after 1–3 **carrier-day advances**, not after real minutes unless a sweep/manual clock advance moves carrier time.

## Claim is approved but not credited

That is a promise, not cash. Credits are due 3–6 carrier days after approval. Automatic chasing starts only after due day + your grace setting (Balanced: 5). After a chase, a stuck fictional credit can post on a later day advance. Use **Mark posted** only if you can actually see the credit in the case/bill context.

## A duplicate submit is blocked

Expected. Haulback’s policy and idempotency key prevent a second active claim for the same charge/category/stage.

## What to report when stuck

Report only non-secret facts:

- service name and public URL;
- workflow name, run status, and failed step name;
- exact visible error text with secrets removed;
- Render deploy status/commit;
- what success message you expected.

Never report database URLs, tokens, passwords, or API keys.

---

# Optional Google Cloud path (not the free route, not run)

`deploy/cloudbuild.yaml` builds both images. `deploy/gcp.sh` deploys:

- `haulback-ledger` to Cloud Run as one instance/concurrency 1;
- `haulback-review` to Cloud Run on port 8080;
- `haulback-sweep` as a Cloud Run job;
- `haulback-hourly` in Cloud Scheduler at minute 37;
- secrets in Secret Manager.

Google Cloud requires a billing account even if usage is small. Treat this as reviewed deployment code for a GCP operator, not as a completed deployment. Export `GCP_PROJECT`, `DATABASE_URL`, `LEDGER_TOKEN`, and `REVIEW_PASSWORD` in your own shell, then run:

```bash
bash deploy/gcp.sh
```

Verify the printed ledger and Control Room URLs, execute the job once manually, and wait for a Scheduler-triggered run before calling that path live.
