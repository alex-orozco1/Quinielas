<p align="center">
  <img src="./public/logo.svg" alt="QRACKS" width="360">
</p>

<h1 align="center">QRACKS ⚽</h1>

<p align="center">
  <strong>Sports prediction pools, made simple.</strong>
</p>

<p align="center">
  Create a pool, invite your friends, collect predictions, publish results, and keep the leaderboard updated automatically.
</p>

<p align="center">
  🌐 <strong>Live Demo:</strong> <a href="https://qracks.net">https://qracks.net</a>
</p>

<p align="center">
  📚 <strong>Documentation (Spanish):</strong> <a href="docs/README.md">docs/README.md</a>: architecture, flows and business rules, development and QA, operations.
</p>

---

## About

QRACKS is a lightweight platform for running private sports prediction pools with friends, coworkers, or communities.

An organizer creates a pool, shares a private link, and participants submit their predictions before each matchday deadline. QRACKS manages the competition lifecycle — from upcoming matchdays and predictions to results, scoring, standings, and tournament history.

Originally built for Liga MX, QRACKS is evolving into a flexible multi-competition sports platform while staying simple, fast, and trustworthy.

> Running a sports pool should feel as easy as creating a WhatsApp group.

---

## How it works

1. Create a pool.
2. Select the competition.
3. Share the private invitation link.
4. Participants join and create their PIN.
5. Publish the next matchday when you're ready.
6. Everyone predicts before the deadline, and predictions lock automatically.
7. Results are captured manually or through the sports data integration.
8. QRACKS scores them and updates the standings.
9. Continue through the competition and keep the final tournament history.

---

## Features

### 👥 Participants

<table>
<tr>
<td width="50%">Join from a shared invitation link</td>
<td width="50%">Live standings</td>
</tr>
<tr>
<td>Personal PIN, securely hashed</td>
<td>Matchday result history</td>
</tr>
<tr>
<td>Predictions saved as you go</td>
<td>Previous tournaments preserved</td>
</tr>
<tr>
<td>Matchday countdown and deadline</td>
<td>Switch user on a shared device</td>
</tr>
<tr>
<td>Server-enforced prediction lock</td>
<td>Mobile-first experience</td>
</tr>
</table>

### 🛠️ Pool administrators

<table>
<tr>
<td width="50%">Create and manage matchdays</td>
<td width="50%">Submission tracking</td>
</tr>
<tr>
<td>Import the competition calendar</td>
<td>WhatsApp reminder generation</td>
</tr>
<tr>
<td>Prepare matchdays before publishing</td>
<td>Manual result capture</td>
</tr>
<tr>
<td>Publish matchdays individually</td>
<td>Automatic result suggestions</td>
</tr>
<tr>
<td>League-specific team selection</td>
<td>Bulk lookup across pending matchdays</td>
</tr>
<tr>
<td>Edit imported or manual fixtures</td>
<td>Publish results and update standings</td>
</tr>
<tr>
<td>Deadline management and reopening</td>
<td>Participant management and PIN reset</td>
</tr>
<tr>
<td>Synchronization diagnostics in plain language</td>
<td>Close a tournament and start the next one</td>
</tr>
</table>

### 🏆 Standings & history

<table>
<tr>
<td width="50%">Automatic scoring</td>
<td width="50%">Full matchday result history</td>
</tr>
<tr>
<td>Leaderboard updated when results publish</td>
<td>Final standings per tournament</td>
</tr>
<tr>
<td>Previous tournament archive</td>
<td>Shareable standings image</td>
</tr>
</table>

### ⚙️ Platform administration

<table>
<tr>
<td width="50%">Dashboard across every pool</td>
<td width="50%">Plan and price configuration</td>
</tr>
<tr>
<td>Pool index and inspection</td>
<td>Plus activation, recorded as a payment</td>
</tr>
<tr>
<td>Entitlement grants and revocation</td>
<td>Manual adjustments with an audit trail</td>
</tr>
<tr>
<td>Payment ledger</td>
<td>Sports-data health monitoring</td>
</tr>
<tr>
<td>Product analytics</td>
<td>Legacy pool migration</td>
</tr>
</table>

---

## Plans

Every pool carries an **entitlement** — an explicit record of what it is allowed to do, who granted it, and when. Enforcement is server-side and fails closed: a missing or unreadable entitlement denies new capacity rather than allowing it.

| | Free | Plus |
|---|---|---|
| Participants | 10 | 50 |
| Matchdays published | 7 | The full tournament, final phases included (see *Plus coverage* below) |
| Price | — | $199 MXN, one payment |
| Scope | — | The one tournament cycle it was bought for |

These are the **current configured values**, not constants. Limits and price live in a server-side commercial configuration that the platform operator edits from the admin panel, and every enforcement decision reads the live row.

A few rules follow from that:

- **Free always tracks the current configuration.** Raising the free participant limit applies to every existing free pool immediately.
- **Plus is a frozen snapshot.** A pool that bought Plus keeps the numbers and price it was sold, even if the configuration changes later.
- **Plus does not roll over.** When an organizer starts a new tournament, the pool returns to Free — a purchase belongs to the tournament it was bought for.
- Pools that predate commercial enforcement are **grandfathered** and keep the experience they already had. Operators can also issue **manual grants** for support, testing, or promotions, with a reason the server requires and records. Unlike a purchase, both of these carry across tournament cycles — they are statuses somebody deliberately granted, not something bought for one tournament.

### Plus coverage

Plus has **no matchday cap** inside the tournament cycle it was bought for: it covers the whole tournament, final phases included. What changes between competitions is only how that is said, and that wording comes from one server-side table, `competitionCoverage.js`, keyed by provider and competition id with a format for each entry. The same sentence appears in Settings, in the offer, in the paywall and as the product description on the Stripe payment page:

| Competition | Format | What Plus says |
|---|---|---|
| Liga MX | league + playoffs | hasta 50 personas y el torneo completo, incluida la liguilla |
| Premier League, La Liga, Bundesliga, Serie A, Ligue 1 | league | hasta 50 personas y el torneo completo |
| UEFA Champions League | league phase + knockout | hasta 50 personas y el torneo completo, incluidas las eliminatorias |
| No competition selected, or one not in the table | — | hasta 50 personas y el torneo completo |

Coverage is **never** inferred from the fixtures the sports API happens to return: an incomplete calendar (a liguilla not yet scheduled, a knockout not yet drawn) would produce a wrong number. A matchday count is shown only when the table defines one **and** the format is a plain league, where that number is the whole competition; none is defined today. What bounds Plus is the tournament cycle: starting a new tournament returns the pool to Free.

**Adding MLS** (or any competition) when it is incorporated:

1. Take the competition id from the sports-data provider's own API — never from memory.
2. Add an entry to `COVERAGE_CATALOG` in `competitionCoverage.js`. MLS is a regular season followed by the MLS Cup Playoffs, so: `"thesportsdb:<id>": entry("MLS", FORMAT.LEAGUE_WITH_PLAYOFFS, "incluidos los playoffs")`, with no matchday count.
3. Add it to the competition picker in `public/index.html` (`SPORTSDB_LEAGUES` and the maps next to it).
4. Run `node --test test/competitionCoverage.test.js`, which fails if a competition in the picker has no coverage entry.

**Paying for Plus** goes through a hosted Stripe Checkout: the organizer is sent to Stripe, pays there, and Plus is activated only after the payment is verified **server-side** against a signed webhook. The page they come back to never activates anything by itself, and QRACKS never sees or stores a card number.

Checkout is off unless the environment carries Stripe credentials. Where it is off — and for support, promotions and exceptions anywhere — a platform operator still activates Plus manually and records the payment in the same operation. The product does not pretend to charge a card it cannot charge.

---

## Matchday lifecycle

One of the core product principles in QRACKS is keeping the state of every matchday predictable.

```text
PREPARED
   ↓
PUBLISHED / OPEN
   ↓
CLOSED
   ↓
RESULTS PUBLISHED
```

**Prepared** — the matchday exists for the administrator, but participants cannot see or interact with it.

**Published / Open** — participants can submit predictions until the configured deadline.

**Closed** — the deadline has passed and predictions can no longer be modified.

**Results Published** — results are final, points are calculated, and the leaderboard updates.

A closed matchday can be reopened by the administrator with a new valid future deadline. This lifecycle keeps the same competition state consistent across matchdays, results, participation tracking, standings and participant flows.

---

## Tournament lifecycle

A pool does not end when a tournament does. Closing a tournament preserves its final standings as history and starts a new cycle in the same pool, with the same participants and the same link.

The cycle identity is **assigned by the server**, never parsed from a provider label or inferred from a date. This matters for split-format leagues: two editions inside one provider season would otherwise be indistinguishable, and a single purchase would silently cover both. Instead, a new cycle is an explicit product event — the organizer starts it — and it is recorded with when it began, what it was called, and how it ended.

---

## Sports data

QRACKS separates **what a competition is** from **where the data came from**.

Above the boundary, the product speaks one vocabulary: competitions, tournament instances, stages, events, competitors. Below it, each provider speaks its own, and an adapter translates. No provider field name appears in server-side product code, every identifier is namespaced by provider, and unknown values stay `null` instead of being guessed. One exception: to suggest team names, the browser queries TheSportsDB's public v1 API directly.

Providers **declare what they can do** rather than having it inferred — whether they model stages, two-legged ties, aggregates, an explicit finished signal, or several tournaments inside one season. Product code asks; it never assumes.

| Provider | Role | Declared capabilities |
|---|---|---|
| TheSportsDB | Default for every pool, and the one behind the league picker | None — no stages, no legs, no finished signal |
| Sportmonks | Fully implemented; opt-in per pool via configuration, not yet exposed in the organizer UI | Stages, legs, aggregates, finished signal, multi-tournament seasons |

Automation covers calendar synchronization, fixture imports, future-round preparation, result lookup, bulk lookup across pending matchdays, eligibility checks before applying automatic results, and diagnostics when something cannot be placed automatically.

**Manual capture is always available**, and automation never removes administrator control. When external data is unavailable, incomplete, or ambiguous, QRACKS says so and lets the organizer decide.

### Beyond regular matchdays

Competition synchronization does not assume a competition is a flat list of numbered matchdays. When a provider publishes later stages of the same tournament, the pool can continue into them without creating a second pool:

- Postseason stages live in the **same tournament scope** as the regular phase — same pool, same participants, same commercial cycle.
- Fixtures are grouped by **structural signals** — the provider's round when it exists, otherwise stage and leg — not by matchday number alone.
- A fixture that arrives with **no round identifier at all** is still placed. Discarding it would silently delete an entire phase.
- Fixtures too far apart in time to belong to the same matchday are **split into separate ones**, so one stage played over two weeks does not collapse into a single deadline.
- **Two-legged ties** are modelled, and the leg number takes part in grouping, so the first and second leg of a tie become two matchdays rather than one. QRACKS scores each leg on its own — there is no aggregate result.
- A fixture whose participants are **not decided yet** is kept aside and placed once the provider resolves it, rather than being dropped and re-imported.
- A fixture's identity is **provider + provider fixture id**. Two providers reusing the same number are two different matches, never one.
- Updates are **additive and safe**: a provider can correct names, kickoff times and undecided participants, but once predictions are locked it can no longer change which team is on which side of a match.

None of this hardcodes a particular competition's shape. Liga MX's postseason is the case it was validated against, not the case it was written for.

### Scoring

Predictions are 1X2, and they resolve from the score **at the end of regulation time plus stoppage**. Extra time and penalty shootouts never change a 1X2 result: a final decided on penalties is a draw.

If the provider does not clearly prove the regulation-time score — or does not prove which team played at home — QRACKS suggests **nothing** and asks the organizer to capture that match manually. A plausible wrong result is worse than no result.

---

## Privacy & integrity

Prediction pools only work when participants trust the system.

- PINs and administrator passwords are hashed with scrypt
- Predictions remain hidden from other participants
- Administrators can verify whether someone submitted without seeing what they submitted
- Deadlines are enforced server-side
- Unpublished matchdays remain hidden from participant workflows
- Draft results remain private
- Incomplete results cannot be published
- Results cannot be published while a matchday is still open
- Reopening a matchday requires a new valid deadline (checked in the browser; the server enforces the deadline on predictions)
- PIN resets invalidate previous sessions
- Concurrent administrator edits are detected rather than silently overwritten
- A database hardening script (`docs/security/`) defines policies that deny direct table access to non-service roles, applied as an operational step. It does not enable row level security by itself; see [`docs/OPERATIONS.md`](docs/OPERATIONS.md) §6
- Legacy pools remain compatible with the current lifecycle
- QRACKS never holds or distributes prize money

### Repeated PIN and password attempts

Every PIN, administrator password and platform password check goes through the same limit on **failed** attempts:

- **First 10 failures:** no wait.
- **After the 10th failure:** a progressive wait, counted from the last failure: 15 s → 30 s → 1 min → 2 min → 4 min → 8 min → **15 min maximum**.
- **Attempts during an active wait** are rejected with the real time left (`429`, `Retry-After`, shown next to the form as a countdown). They do not count as failures and do not extend the wait.
- **Repeating a PIN or password already tried** does not get around it: it is counted once, but it waits like any other attempt.
- **The history resets after 24 h without failures**, or when the credential changes to a different value (a PIN reset, a new password). Saving the same value again does not reset it (except another participant's PIN written by an admin, where telling "same" from "different" would reveal it).
- **No successful login resets the counter**, whether typed into a login form or resent by the browser (a stored session or PIN). Otherwise every login by the owner would hand an attacker a fresh set of free attempts.
- **Per credential:** an attack on one person's PIN never locks out anyone else, and devices that already signed in with that credential keep working during the wait. That trust is tied to the credential's current value: changing or resetting a PIN or password ends it for every other device (the device that made the change is trusted for the new value). Looser per-network limits (by the real client IP) slow down spraying across many people.
- **Forgotten PIN:** the PIN prompt has «¿Olvidaste tu PIN?». An admin with no session, no trusted device and no other admin chooses a new PIN by proving the pool's administrator password, which goes through this same limit (a successful recovery does not reset it). The new PIN is always a new credential, even if it is the same value: other sessions and trusted devices of that admin end, and the old PIN is never shown. A participant is told to ask an admin to reset theirs.

Details, limits and recovery: [`docs/SECURITY_CREDENTIAL_LIMITS.md`](docs/SECURITY_CREDENTIAL_LIMITS.md).

---

## Supported competitions

The organizer's competition picker currently covers:

- 🇲🇽 Liga MX
- 🇬🇧 Premier League
- 🇪🇸 La Liga
- 🇩🇪 Bundesliga
- 🇮🇹 Serie A
- 🇫🇷 Ligue 1
- 🇪🇺 UEFA Champions League

Liga MX additionally has a multi-tournament season configuration validated against real Sportmonks data — used when a pool is configured for that provider.

Teams, fixtures and results can always be managed manually, for these competitions or any other.

Adding a competition is intended to be configuration rather than a rewrite, and the architecture is not restricted to football — other sports become possible as sports-data coverage expands.

---

## Architecture

QRACKS intentionally uses a lightweight architecture while the product validates real usage.

```text
Participant / Admin
        │
        ▼
   QRACKS Web App
        │
        ▼
 Node.js + Express
        │
   ┌────┴───────────────────┐
   ▼                        ▼
PostgreSQL        Sports Data Domain
                            │
                   Provider Abstraction
                            │
                  ┌─────────┴─────────┐
                  ▼                   ▼
            TheSportsDB           Sportmonks
```

The sports-data layer is separated from the core competition logic so that changing providers, or running two side by side, does not redefine how QRACKS itself works.

Manual administration remains available as a fallback whenever external data is unavailable or incomplete.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, Vanilla JavaScript |
| Backend | Node.js + Express |
| Database | PostgreSQL |
| Sports Data | Provider abstraction — TheSportsDB (default), Sportmonks (opt-in) |
| Deployment | Render |
| Testing | Node Test Runner (unit, structural and PostgreSQL integration tests). Browser checks for each PR run with Playwright outside the repository; CI only runs the secret check |

---

## Project structure

```text
.
├── docs/                # documentation index: docs/README.md
├── payments/            # Stripe boundary and payment domain
├── providers/           # one adapter per sports data provider
├── public/
├── scripts/
├── test/
├── competitionCoverage.js # what Plus covers, per competition
├── competitionSync.js   # provider fixtures -> matchdays
├── planLimits.js        # plans, entitlements, enforcement
├── scoreContract.js     # regulation-time scoring
├── sportsDomain.js      # the provider-agnostic vocabulary
├── sportsDataProvider.js
├── tournamentScope.js   # tournament cycle identity
├── server.js
├── package.json
├── render.yaml
└── README.md
```

Abridged — several smaller modules (auto-result eligibility, participant
merging, platform state, concurrency, provider health) live alongside these
at the repository root.

---

## Run locally

### Requirements

- Node.js 18+
- PostgreSQL

### Installation

Clone the repository:

```bash
git clone https://github.com/alex-orozco1/Quinielas.git
cd Quinielas
```

Install dependencies:

```bash
npm install
```

Configure the required environment variables:

```env
DATABASE_URL=postgresql://localhost:5432/qracks
PLATFORM_PASSWORD=your-password
```

Start the application:

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

---

## Testing

QRACKS maintains automated regression coverage for critical product and competition behavior.

```bash
node --test test/*.test.js
```

Critical areas covered include:

- Competition lifecycle and matchday publication
- Deadline enforcement and prediction integrity
- Result publication and scoring
- Competition synchronization and fixture identity
- Postseason stages, two-legged ties and undecided participants
- Automatic results and manual fallback
- Plans, entitlements and enforcement
- Tournament cycles and renewal
- Concurrent writes and payment integrity
- Legacy compatibility
- Administrator workflows and participant visibility

High-risk lifecycle and commercial changes are additionally validated against a real PostgreSQL instance and through browser-based end-to-end testing.

Some tests start the real server against a throwaway **local** PostgreSQL database (they create it and drop it; any host other than localhost is refused). Without `QRACKS_TEST_DATABASE_URL` each of them is reported as skipped, with the reason, so a run without PostgreSQL never reads as a pass. Credentials go in the standard libpq variables (or `~/.pgpass`), never in the URL:

```bash
pg_ctlcluster 16 main start
export PGUSER=postgres PGPASSWORD='<local password>'   # or ~/.pgpass
QRACKS_TEST_DATABASE_URL=postgres://localhost:5432/postgres node --test test/*.test.js
```

---

## Deployment

QRACKS is currently deployed on Render, configured through `render.yaml`.

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PLATFORM_PASSWORD` | Platform administrator password |
| `STRIPE_SECRET_KEY` | Stripe secret key. Server-only — never sent to a browser. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret, used to verify that an event really came from Stripe. |
| `PUBLIC_BASE_URL` | The public origin (e.g. `https://qracks.net`), used to build the return URLs a checkout comes back to. |

`PORT` (default `3000`) and `PG_POOL_MAX` (default `10`) are optional. `THESPORTSDB_API_KEY` and
`SPORTMONKS_API_TOKEN` belong to the sports-data integration, not to payments. Currency (MXN), the
Stripe API version and the webhook path are fixed in code; the Plus price and limits come from the
Platform Panel (`commercial_config`), never from the environment.

The server evaluates the three Stripe variables **once, at startup**, into one of three states that
every payment path shares — the Plus screen, checkout, the webhook and reconciliation:

| State | When | What organizers see |
|---|---|---|
| `READY` | All three present and valid, and Stripe accepts the key | Card checkout |
| `DISABLED` | **No** Stripe credential at all — payments deliberately off | The manual fallback (only when nothing for that tournament could still be charging) |
| `MISCONFIGURED` | Any Stripe credential present but something missing or wrong | Card payment "not available right now". No checkout, no webhook processing, **no** manual fallback — it is a deployment error, not a commercial choice |

A partial configuration never opens a checkout it could not confirm, and never looks like a
deliberate shutdown. While Stripe is `READY`, the Plus screen never tells an organizer to write in to buy.

### MON-003 / Stripe deployment checklist

**Sandbox** (Stripe *test mode* → QRACKS sandbox)

- `PUBLIC_BASE_URL=https://qracks-mon003-sandbox.onrender.com`
- `STRIPE_SECRET_KEY` = the **test-mode** secret key
- Webhook destination URL: `https://qracks-mon003-sandbox.onrender.com/api/payments/stripe/webhook`
- `STRIPE_WEBHOOK_SECRET` = the signing secret **of that sandbox destination**

**Production** (Stripe *live mode* → qracks.net)

- `PUBLIC_BASE_URL=https://qracks.net`
- `STRIPE_SECRET_KEY` = the **live-mode** secret key
- Webhook destination URL: `https://qracks.net/api/payments/stripe/webhook`
- `STRIPE_WEBHOOK_SECRET` = the signing secret **of that production destination**

**Both**

- `PUBLIC_BASE_URL` is the bare origin: `https://`, no path, no trailing `?`/`#` (a trailing `/` is fine). It is
  where Stripe sends the customer back, so it is never taken from the browser or the `Host` header.
- Webhook events — exactly these six: `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`.
- Create the webhook destination with API version `2026-08-26.dahlia` (the one pinned in code).
- **Never mix modes.** A test key with a live signing secret (or the reverse) is not detectable from the
  environment alone: a signing secret carries no mode. Every webhook would then fail its signature — the
  Platform Panel shows those rejections. A signing secret belongs to **one** destination: rotating or
  recreating the destination means updating `STRIPE_WEBHOOK_SECRET` and restarting.
- **Confirm before any end-to-end test.** Right after a deploy, the log has one line:
  - `payments_readiness {"when":"startup","state":"ready","mode":"test","host":"qracks-mon003-sandbox.onrender.com","webhookUrl":"…/api/payments/stripe/webhook",…}` — good to go. Check that `mode` and `host` are the ones you expect.
  - `PAYMENTS MISCONFIGURED {…"problems":["missing:PUBLIC_BASE_URL"]…}` — fix what `problems` names, then restart.
  - `payments_readiness {…"state":"disabled"…}` — no Stripe credentials: payments are off on purpose.

  The same diagnosis, in words and with the exact webhook URL to register, is on the Platform Panel under
  **Pagos (Stripe)**. No value of any credential is ever logged or shown.

Production: 🌐 **https://qracks.net**

Operational runbook: [`docs/OPERATIONS.md`](docs/OPERATIONS.md). Full documentation index: [`docs/README.md`](docs/README.md).

---

## Product principles

### Simplicity over complexity

Running a pool should not require a manual, spreadsheet or complicated setup.

### Trust above everything

Predictions, deadlines, results and standings must always behave predictably.

### Mobile first

Most participants interact with QRACKS from their phones, often directly from a shared WhatsApp link.

### Fast enough to disappear

Performance should never become part of the experience.

### Useful before impressive

QRACKS prioritizes solving real organizer and participant problems over building features simply because they are technically interesting.

### One clear action

Where possible, every screen should make the next meaningful action obvious.

---

## Product philosophy

QRACKS is not a sportsbook: it does not manage bets, hold prize money or distribute winnings. It is built for groups who already organize prediction pools themselves, and its job is to remove the operational work.

When QRACKS charges, it charges for the software — never a cut of whatever the group plays for. Handling prize money is not part of the product, and the payments work does not move it in that direction: money for Plus goes from the organizer to QRACKS through a payment provider, and whatever the group plays for never touches the platform.

**Less spreadsheet, less chasing people, less manual scoring — more playing.**

---

## Roadmap

Where the product stands today. New ideas are prioritized against these stages rather than automatically becoming new initiatives; what comes next is in the section below.

| Stage | Status | What it means |
|---|---|---|
| Core Product | ✅ Established | Create, join, predict, score, rank, administer |
| Performance & Stability | ✅ Continuous | Payload optimization, connection pooling, concurrency safety |
| Sports Data Reliability | ✅ Implemented | Provider abstraction, competition sync, postseason support, fail-closed scoring |
| Monetization Foundation | ✅ Implemented | Plans, entitlements, server-side enforcement, tournament cycles |
| Payments | ✅ Implemented | Hosted Stripe Checkout, verified server-side. Live wherever the environment is configured for it. |
| Product Iteration | 🔄 Continuous | Removing friction from organizer and participant workflows, guided by real usage |
| Advanced features | ⏸️ On hold | Capabilities beyond today's core loop wait until it shows recurring usage. Unrelated to the Plus plan, which already works. |

---

## What's next

In order, and without dates:

1. **Payments, in production**: the Plus checkout is live (MON-003). What remains is watching the first purchases closely.
2. **Help** — today's per-screen tips become one help system, written once and used across the landing page, participant and administrator views.
3. **Product iteration** — watch real pools, measure where people actually get stuck, and fix what the evidence shows rather than what seems likely.
4. **Sports-data rollout** — turn the provider capabilities already built into a safe organizer experience, including choosing and migrating providers. The architecture is ready; the product experience is not.
5. **More competitions and sports** — broaden coverage once the current flow is stable, and only where simplicity survives. Basketball, motorsport and the rest are possibilities, not commitments.

---

## Success criteria

The target is **100 active pools** — not for the number itself, but for what it proves: recurring use and willingness to pay. Organizers creating a second pool, participants returning each matchday, and organizers paying for the work QRACKS removes.

**Done > Perfect.** Ship, observe, learn, improve.

---

## Contributing

QRACKS is currently under active independent development.

Contributions should follow the product principles above, and two rules that matter most in this codebase: preserve backward compatibility with existing pools, and prefer small, verifiable improvements over large speculative rewrites.

---

## Status

🚧 Active development

🌐 https://qracks.net

Made with ❤️ for football fans. Built independently in Mexico 🇲🇽 for football fans everywhere.
