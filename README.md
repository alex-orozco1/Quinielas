<div align="center">

<img src="./public/logo.svg" alt="QRACKS logo" width="220" />

# QRACKS ⚽

**Sports prediction pools, made simple.**

Create a pool, invite your friends, collect predictions, publish results, and keep the leaderboard updated automatically.

🌐 **Live Demo:** https://qracks.net

</div>

---

## About

QRACKS is a lightweight platform for running private sports prediction pools with friends, coworkers, or communities.

An organizer creates a pool, shares a private link, and participants submit their predictions before each matchday deadline. Once results are published, QRACKS automatically calculates scores and updates the leaderboard.

Originally built for Liga MX, QRACKS is evolving into a flexible platform that supports multiple competitions while staying simple, fast, and trustworthy.

> Running a sports pool should feel as easy as creating a WhatsApp group.

---

## How it works

1. Create a pool.
2. Share the private invitation link.
3. Participants join and create their PIN.
4. Everyone submits predictions.
5. Predictions lock automatically at the deadline.
6. The organizer publishes results.
7. QRACKS updates the standings automatically.

---

## Features

### Participants

- Join from a shared invitation link
- Secure personal PIN
- Automatic draft saving
- Matchday countdown
- Live standings
- Match history
- Previous tournaments
- Switch participants on shared devices

### Pool administrators

- Create and edit matchdays
- League-specific team selection
- Deadline management
- Submission tracking
- WhatsApp reminder generation
- Manual or TheSportsDB result capture
- Publish results
- Automatic leaderboard updates
- Participant management
- PIN reset
- Tournament closing with historical standings

### Platform

- Platform administration dashboard
- Pool management
- Payment tracking
- Exemption management
- Global platform configuration

---

## Product principles

QRACKS is built around five principles:

- Simplicity over complexity
- Trust above everything
- Mobile-first
- Fast enough to disappear
- Useful before impressive

---

## Privacy & Integrity

QRACKS includes safeguards designed for private prediction pools.

- PINs and administrator passwords are securely hashed
- Predictions remain hidden until results are published
- Administrators can verify submissions without viewing predictions
- Deadlines are enforced on the server
- Draft results remain private
- Incomplete results cannot be published
- PIN resets invalidate previous sessions
- QRACKS never holds prize money

---

## Supported competitions

Automatic team selection and result suggestions currently support:

- Liga MX
- Premier League
- La Liga
- Bundesliga
- Serie A
- Ligue 1
- UEFA Champions League

Teams and results can also be entered manually.

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | HTML, CSS, Vanilla JavaScript |
| Backend | Node.js + Express |
| Database | PostgreSQL |
| External API | TheSportsDB |
| Deployment | Render |

---

## Project structure

```text
.
├── public/
│   ├── favicon.svg
│   ├── index.html
│   ├── logo.svg
│   └── og-image.png
├── server.js
├── package.json
├── package-lock.json
├── render.yaml
└── README.md
```

---

## Run locally

### Requirements

- Node.js 18+
- PostgreSQL

### Installation

```bash
git clone https://github.com/alex-orozco1/Quinielas.git
cd Quinielas
npm install
```

Configure the required environment variables:

```text
DATABASE_URL=postgresql://user:password@localhost:5432/qracks
PLATFORM_PASSWORD=your-password
```

Run the application:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

---

## Deployment

The repository includes a `render.yaml` configuration for deployment on Render.

Required environment variables:

| Variable | Description |
|----------|-------------|
| DATABASE_URL | PostgreSQL connection string |
| PLATFORM_PASSWORD | Platform administrator password |

---

## Current focus

- Competition integrity
- Administrator experience
- Mobile usability
- Performance improvements
- Growth toward the first 100 active pools

---

## Status

🚧 Active development

🌐 https://qracks.net

Made with ❤️ for football fans.
Built independently in Mexico 🇲🇽 for football fans everywhere.
