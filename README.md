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
| Matchdays published | 7 | 18, or the full tournament when a competition is selected |
| Price | — | $199 MXN, one payment |
| Scope | — | The one tournament cycle it was bought for |

These are the **current configured values**, not constants. Limits and price live in a server-side commercial configuration that the platform operator edits from the admin panel, and every enforcement decision reads the live row.

A few rules follow from that:

- **Free always tracks the current configuration.** Raising the free participant limit applies to every existing free pool immediately.
- **Plus is a frozen snapshot.** A pool that bought Plus keeps the numbers and price it was sold, even if the configuration changes later.
- **Plus does not roll over.** When an organizer starts a new tournament, the pool returns to Free — a purchase belongs to the tournament it was bought for.
- Pools that predate commercial enforcement are **grandfathered** and keep the experience they already had. Operators can also issue **manual grants** for support, testing, or promotions, with a reason the server requires and records. Unlike a purchase, both of these carry across tournament cycles — they are statuses somebody deliberately granted, not something bought for one tournament.

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

Above the boundary, the product speaks one vocabulary: competitions, tournament instances, stages, events, competitors. Below it, each provider speaks its own, and an adapter translates. No provider field name appears in product code, every identifier is namespaced by provider, and unknown values stay `null` instead of being guessed.

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
- Reopening a matchday requires a new valid deadline
- PIN resets invalidate previous sessions
- Concurrent administrator edits are detected rather than silently overwritten
- A database hardening script (`docs/security/`) denies direct table access to non-service roles, applied as an operational step
- Legacy pools remain compatible with the current lifecycle
- QRACKS never holds or distributes prize money

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
| Testing | Node Test Runner + browser/E2E validation |

---

## Project structure

```text
.
├── docs/
├── providers/           # one adapter per sports data provider
├── public/
├── scripts/
├── test/
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
DATABASE_URL=postgresql://user:password@localhost:5432/qracks
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

The three Stripe variables are required **together**: with only some of them the
product would be able to start a charge it could never verify, so payments stay
switched off unless all three are present. When they are absent, the upgrade
path falls back to the manual one and says so — it never shows a checkout that
cannot charge.

Production: 🌐 **https://qracks.net**

Operational runbook: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)

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

1. **Payments, in production** — the checkout is built and verified; what remains is turning it on for real traffic and watching the first purchases closely.
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
