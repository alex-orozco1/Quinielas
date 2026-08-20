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
6. Everyone submits their predictions before the deadline.
7. Predictions lock automatically.
8. Results are captured manually or through the sports data integration.
9. QRACKS calculates scores and updates the standings.
10. Continue through the competition and preserve the final tournament history.

---

## Features

### 👥 Participants

- Join from a shared invitation link
- Secure personal PIN
- Automatic prediction saving
- Matchday countdown
- Server-enforced deadlines
- Live standings
- Match history
- Previous tournaments
- Switch participants on shared devices
- Mobile-first experience

### 🛠️ Pool administrators

- Create and manage matchdays
- Import competition calendars
- Keep future matchdays prepared before publication
- Publish matchdays individually
- League-specific team selection
- Edit imported or manually created fixtures
- Deadline management
- Submission tracking
- WhatsApp reminder generation
- Manual result capture
- Automatic result suggestions
- Bulk search for pending results
- Publish results
- Automatic leaderboard updates
- Participant management
- PIN reset
- Tournament closing with historical standings

### 📅 Competition management

QRACKS manages matchdays through an explicit lifecycle:

**Prepared → Published / Open → Closed → Results Published**

Future matchdays can exist in the administrator panel without being exposed to participants until the organizer publishes them.

Competition synchronization can import the available calendar and keep future rounds ready for the administrator, reducing repetitive manual setup.

### 🤖 Sports data automation

QRACKS integrates external sports data to reduce administrative work while preserving administrator control.

Current automation includes:

- Competition calendar synchronization
- Matchday and fixture imports
- Future-round preparation
- Result lookup
- Bulk lookup across pending matchdays
- Eligibility checks before applying automatic results
- Manual fallback when external data is unavailable
- Competition synchronization diagnostics

Automation assists the organizer without removing manual control.

### 🏆 Standings & history

- Automatic scoring
- Updated leaderboard after results are published
- Historical matchday results
- Final tournament standings
- Previous tournament history
- Shareable standings

### ⚙️ Platform administration

- Platform administration dashboard
- Pool management
- Payment tracking
- Exemption management
- Global platform configuration
- Legacy pool compatibility

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

### Prepared

The matchday exists and can be managed by the administrator, but participants cannot see or interact with it yet.

### Published / Open

The administrator publishes the matchday and participants can submit predictions until the configured deadline.

### Closed

The deadline has passed and predictions can no longer be modified.

### Results Published

Final results are published and QRACKS calculates the corresponding points and updates the leaderboard.

A closed matchday can also be reopened by the administrator with a new valid future deadline.

This lifecycle keeps the same competition state consistent across **Jornadas, Resultados, Participación, standings and participant flows**.

---

## Privacy & integrity

Prediction pools only work when participants trust the system.

QRACKS includes safeguards designed to protect competition integrity:

- PINs and administrator passwords are securely hashed
- Predictions remain hidden from other participants
- Administrators can verify whether someone submitted without exposing their predictions
- Deadlines are enforced server-side
- Future unpublished matchdays remain hidden from participant workflows
- Draft results remain private
- Incomplete results cannot be published
- Results cannot be published while a matchday is still open
- Reopening a matchday requires a new valid deadline
- PIN resets invalidate previous sessions
- Legacy pools remain compatible with the current lifecycle
- QRACKS never holds or distributes prize money

---

## Supported competitions

Automatic competition support currently includes:

- 🇲🇽 Liga MX
- 🏴 Premier League
- 🇪🇸 La Liga
- 🇩🇪 Bundesliga
- 🇮🇹 Serie A
- 🇫🇷 Ligue 1
- 🇪🇺 UEFA Champions League

Teams, fixtures and results can also be managed manually when necessary.

**More leagues are coming.**

QRACKS is being built so additional competitions can be added without changing the core pool experience.

The longer-term architecture is not restricted to football. Other competitions and sports can be incorporated as QRACKS expands its sports-data coverage.

---

## What we've built

QRACKS has evolved through more than **15 product and engineering sprints**, progressively turning a simple football pool into a reliable product.

### Core Product

The original QRACKS experience established the complete pool loop:

- Pool creation
- Private invitations
- Participant registration
- PIN authentication
- Predictions
- Matchday deadlines
- Result capture
- Automatic scoring
- Standings
- History
- Administrator workflows

### Product Experience

QRACKS developed its own product identity and progressively simplified both organizer and participant workflows:

- QRACKS visual identity
- Responsive experience
- Mobile-first improvements
- Landing page evolution
- Consistent navigation
- Clear primary actions
- Administrator UX improvements
- Participant UX improvements
- Better system feedback
- Better loading and empty states
- Sharing flows
- Shareable standings

### Administration

The administrator experience has evolved from manually maintaining a pool toward managing the competition itself.

Current capabilities include:

- Matchday management
- Prepared future matchdays
- Explicit matchday publication
- Fixture editing
- Deadline management
- Participation monitoring
- Participant administration
- PIN reset
- Result management
- Competition settings
- Additional pool settings
- Tournament closure

Recent lifecycle work also ensures that prepared, unpublished matchdays remain available to administrators without incorrectly appearing as actionable matchdays in participant-facing or participation workflows.

### Competition Automation

Competition management now reduces much of the repetitive work required from organizers:

- Competition selection
- League-specific teams
- Calendar synchronization
- Automatic fixture imports
- Prepared vs. published matchdays
- Future-round synchronization
- Automatic result lookup
- Bulk pending-result lookup
- Eligibility validation
- Manual fallback
- Synchronization diagnostics

Administrators remain in control of when a matchday becomes part of the active pool.

### Trust & Security

Multiple iterations have focused specifically on protecting competition integrity:

- Hidden participant predictions
- Role-aware API payloads
- Server-side deadline enforcement
- Secure PIN/password handling
- Administrator authentication
- Database security hardening
- Row-level security work
- Safe result publication
- Matchday lifecycle validation
- Legacy compatibility

### Performance

Performance work has reduced unnecessary server and client processing as pools grow:

- Role-specific payload optimization
- Prediction filtering improvements
- O(1) lookup maps for repeated operations
- PostgreSQL connection pooling
- Concurrent request handling improvements
- Request deduplication
- Faster leaderboard workflows
- Faster administrator workflows

### Platform & Growth

QRACKS has also begun building the foundations required to operate as a real product:

- Platform administration
- Pool indexing
- Legacy pool migration
- Payment-status infrastructure
- Exemption management
- SEO foundations
- Accessibility improvements
- Growth measurement foundations
- Product analytics foundations

---

## Product principles

QRACKS is built around a small set of principles:

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

QRACKS is not a sportsbook.

It does not manage bets, hold prize money or distribute winnings.

It is a lightweight competition platform designed around friends, coworkers and communities who already organize prediction pools themselves.

The product's job is to remove the operational work:

**less spreadsheet, less chasing people, less manual scoring — more playing.**

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
   ┌────┴─────┐
   ▼          ▼
PostgreSQL   Sports Data Provider
                 │
                 ▼
           External Sports Data
```

The sports-data layer is separated from the core competition logic so provider changes or additional sports-data sources do not need to redefine how QRACKS itself works.

Manual administration remains available as a fallback when external sports data is unavailable or incomplete.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, Vanilla JavaScript |
| Backend | Node.js + Express |
| Database | PostgreSQL |
| Sports Data | TheSportsDB + provider abstraction |
| Deployment | Render |
| Testing | Node Test Runner + browser/E2E validation |

The architecture intentionally remains lightweight while QRACKS validates product-market fit.

---

## Project structure

```text
.
├── public/
│   ├── favicon.svg
│   ├── index.html
│   ├── logo.svg
│   └── og-image.png
├── providers/
├── scripts/
├── test/
├── autoResults.js
├── competitionSync.js
├── seasonDefaults.js
├── sportsDataProvider.js
├── server.js
├── package.json
├── render.yaml
└── README.md
```

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

Run the test suite with:

```bash
node --test test/*.test.js
```

Critical areas covered include:

- Competition lifecycle
- Matchday publication
- Deadline enforcement
- Prediction integrity
- Result publication
- Scoring
- Competition synchronization
- Automatic results
- Legacy compatibility
- Administrator workflows
- Participant visibility

High-risk UX and lifecycle changes are additionally validated through browser-based end-to-end testing when appropriate.

---

## Deployment

QRACKS is currently deployed on Render.

The repository includes:

```text
render.yaml
```

for deployment configuration.

Required environment variables include:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PLATFORM_PASSWORD` | Platform administrator password |

Production:

🌐 **https://qracks.net**

---

## Current focus

QRACKS is currently focused on making the existing product increasingly reliable before expanding its scope.

Current priorities include:

- Competition integrity
- Administrator experience
- Participant experience
- Mobile usability
- Sports-data reliability
- Competition synchronization
- Automatic results
- Safe manual fallbacks
- Performance
- Stability
- Better empty and system states
- Additional competition coverage
- Growth toward the first 100 active pools

The goal is **not premature scale**.

The goal is proving that QRACKS makes running a prediction pool dramatically easier.

---

## Roadmap

QRACKS follows an incremental product roadmap.

New ideas are prioritized against existing product stages rather than automatically becoming new initiatives.

### ✅ Core Product

The fundamental pool experience:

- Create
- Join
- Predict
- Score
- Rank
- Administer

### ✅ Performance & Stability

Improve the reliability and speed of the existing experience.

### ✅ Marketing & Product Experience

Establish QRACKS' identity and make the product understandable before someone creates their first pool.

### ✨ Product Polish

Continue removing friction and inconsistencies across administrator and participant workflows.

### 📈 Growth

Improve measurement, acquisition, activation and organizer retention.

### ⭐ Premium Features

Introduce higher-value capabilities only after the core experience demonstrates recurring usage.

### ⚙️ Engineering & Documentation

Continue strengthening architecture, security, observability and maintainability.

### 🚀 Launch Readiness

Ensure the complete experience is reliable enough to confidently expand usage.

### 📊 Product Iteration

Use real organizer and participant behavior to determine the next improvements.

This includes richer competition insights and potential evolution of leaderboard visualization.

### 💰 Monetization

Monetization comes after QRACKS proves recurring value.

QRACKS does not need to become a payments or gambling platform to monetize the organization of prediction pools.

---

## What's next

The immediate evolution of QRACKS centers around making competition management increasingly automatic without making the product more complicated.

Areas under consideration include:

- More football leagues
- Improved sports-data reliability
- Additional sports-data providers
- Better automation monitoring
- Clear alerts when automatic sports data cannot be refreshed
- Expanded competition history
- Better organizer insights
- Continued mobile optimization
- Richer leaderboard visualization
- Additional sports

Potential future sports coverage may include competitions such as:

- 🏀 Basketball
- 🏈 American football
- ⚾ Baseball
- 🎾 Tennis
- 🏎️ Motorsport
- 🥊 Combat sports

These are future directions, not commitments to immediate implementation.

QRACKS will expand only where doing so preserves the simplicity of the core experience.

---

## Success criteria

QRACKS is currently validating whether it can become the easiest way to organize a private sports prediction pool.

Near-term product signals include:

- 100 active pools
- Organizers creating another pool
- Participants consistently returning each matchday
- Fast onboarding
- Simple administration
- Reliable competition data
- Organizers willing to pay for the value QRACKS removes from their workflow

**Done > Perfect.**

Ship, observe, learn, improve.

---

## Contributing

QRACKS is currently under active independent development.

The repository documents the evolution of the product as it moves from an initial football-pool tool toward a broader sports prediction platform.

When contributing, preserve the core principles:

- Do not add complexity without demonstrated value.
- Protect participant trust.
- Preserve backward compatibility where possible.
- Keep administrator workflows simple.
- Treat mobile as a first-class experience.
- Prefer small, verifiable improvements over large speculative rewrites.

---

## Status

🚧 Active development

🌐 https://qracks.net

Made with ❤️ for football fans. Built independently in Mexico 🇲🇽 for football fans everywhere.
