<div align="center">
  <img src="./public/logo.svg" alt="QRACKS logo" width="220" />

  <p><strong>Sports prediction pools, made simple.</strong></p>

  <p>
    Create a pool, invite your friends, collect predictions, publish results,
    and keep the standings updated automatically.
  </p>

  <p>
    <a href="https://qracks.net"><strong>Open QRACKS</strong></a>
  </p>
</div>

---

## About QRACKS

QRACKS is a lightweight web platform for running sports prediction pools with friends, coworkers, or private communities.

An organizer creates a pool and shares its private link. Participants join, set a personal PIN, submit their predictions before each deadline, and follow the leaderboard as results are published.

The product started as a Liga MX pool for one group of friends and evolved into a multi-pool platform designed around simplicity, privacy, and trust.

> Running a sports pool should feel as easy as creating a WhatsApp group.

## What you can do

### Participants

- Join a pool from its shared link
- Create and use a personal four-digit PIN
- Submit predictions before the matchday deadline
- Save picks automatically
- Follow the countdown until picks lock
- Review open, live, and completed matchdays
- See standings, scoring history, and previous tournaments
- Change participant on shared devices

### Pool administrators

- Create and edit matchdays
- Select teams based on the configured competition
- Set deadlines for every round
- Track who has submitted picks without revealing their predictions
- Prepare WhatsApp reminders for pending participants
- Capture results manually or retrieve suggestions from TheSportsDB
- Publish results and update the leaderboard
- Add, rename, remove, and manage participants
- Reset participant PINs
- Configure the pool, league, season, and entry fee
- Close a tournament while preserving its final standings and champion

### Platform operations

- Review all pools from a private platform dashboard
- Inspect pool status and activity
- Manage pool information
- Track payment and exemption status
- Configure global operating settings

## How it works

1. An organizer creates a pool.
2. QRACKS generates a permanent pool link.
3. The organizer shares the link with participants.
4. Participants join, create a PIN, and submit their picks.
5. Predictions lock automatically at the configured deadline.
6. The organizer publishes the match results.
7. QRACKS calculates points and updates the standings.

## Product principles

QRACKS is built around five principles:

- **Simplicity over complexity** — common tasks should be easy to understand and complete.
- **Trust above everything** — deadlines, privacy, scoring, and results must behave predictably.
- **Mobile-first** — every core flow should work comfortably on a phone.
- **Fast enough to disappear** — the product should stay out of the competition itself.
- **Useful before impressive** — practical improvements take priority over unnecessary features.

## Privacy and competition integrity

QRACKS includes safeguards designed for private social pools:

- Participant PINs and administrator passwords are stored as hashes
- Open predictions are hidden from other participants
- Administrators can see who submitted without seeing their picks
- Deadlines are validated by the server
- Draft results are not exposed to participants
- Incomplete results cannot be published
- Resetting a participant PIN invalidates previous sessions
- The platform does not hold or distribute prize money

QRACKS is intended for friendly prediction pools. It should not be used as a high-security financial or gambling platform.

## Supported competitions

Automatic result suggestions and league-specific team selection currently support:

- Liga MX
- Premier League
- La Liga
- Bundesliga
- Serie A
- Ligue 1
- UEFA Champions League

Organizers can still enter teams and results manually when needed.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, Vanilla JavaScript |
| Backend | Node.js, Express |
| Database | PostgreSQL |
| External data | TheSportsDB |
| Deployment | Render |

The frontend is currently delivered as a single-page application from `public/index.html`, with views determined by the URL. The backend exposes the application API, enforces permissions and deadlines, and persists data in PostgreSQL.

## Main routes

| Route | Purpose |
|---|---|
| `/` | Public landing page |
| `/crear` | Create a new pool |
| `/q/:slug` | Open a specific pool |
| `/panel-plataforma` | Private platform dashboard |

## Project structure

```text
.
├── public/
│   ├── index.html
│   ├── logo.svg
│   ├── favicon.svg
│   └── og-image.png
├── server.js
├── package.json
├── package-lock.json
├── render.yaml
└── README.md
```

## Run locally

### Requirements

- Node.js 18 or later
- A PostgreSQL database

### Setup

1. Clone the repository.

```bash
git clone https://github.com/alex-orozco1/Quinielas.git
cd Quinielas
```

2. Install dependencies.

```bash
npm install
```

3. Set the required environment variables.

```bash
export DATABASE_URL="postgresql://user:password@localhost:5432/qracks"
export PLATFORM_PASSWORD="replace-with-a-secure-password"
```

4. Start the application.

```bash
npm start
```

5. Open `http://localhost:3000`.

The server intentionally refuses to start when either required environment variable is missing.

## Deployment

The repository includes a `render.yaml` file for deployment on Render.

Required environment variables:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PLATFORM_PASSWORD` | Initial password for the private platform dashboard |

Optional environment variables:

| Variable | Description |
|---|---|
| `PORT` | Application port; defaults to `3000` |
| `PG_POOL_MAX` | Maximum PostgreSQL connection pool size; defaults to `10` |

For hosted databases that require TLS, the server enables SSL automatically when the connection is not local.

## Current product focus

The current roadmap prioritizes:

- Reliability and competition integrity
- A faster, safer administrator experience
- Mobile usability and accessibility
- A clearer landing page and stronger activation
- Sustainable growth toward the first 100 active pools

Broader monetization and multi-sport expansion will be evaluated separately.

## Status

QRACKS is an actively developed independent product. The public application is available at [qracks.net](https://qracks.net).
