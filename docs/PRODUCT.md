# QRACKS Product Documentation

Version: 1.0

Last updated: July 2026

---

# 1. Product Overview

QRACKS is a web platform that allows people to create and manage private sports prediction pools.

An organizer creates a pool, shares a private invitation link, and participants submit predictions before each matchday deadline.

Once the organizer publishes the official results, QRACKS automatically calculates scores, updates the leaderboard, and preserves the tournament history.

The platform is designed for groups of friends, families, offices, schools, and private communities.

QRACKS does not manage prize money.

---

# 2. Vision

Running a prediction pool should be as simple as creating a WhatsApp group.

Users should spend their time competing with friends—not managing spreadsheets, calculating scores, or reminding participants manually.

QRACKS removes the operational work so organizers can focus on the competition.

---

# 3. Product Philosophy

Every product decision follows five principles.

## Simplicity

The most common tasks should require the fewest possible clicks.

---

## Trust

Deadlines, scoring, standings, and privacy must always behave predictably.

---

## Mobile First

Every core workflow must be comfortable on a phone.

---

## Speed

The product should feel lightweight and never interrupt the competition.

---

## Practicality

Useful improvements always have priority over visually impressive features.

---

# 4. User Roles

QRACKS has three roles.

## Participant

A participant joins a pool, creates a personal PIN, submits predictions, and follows the tournament.

Participants cannot modify matchdays, scores, or other users.

---

## Pool Administrator

The administrator manages one prediction pool.

Responsibilities include:

- Creating matchdays
- Managing participants
- Publishing results
- Updating standings
- Configuring the tournament
- Managing deadlines

---

## Platform Administrator

The platform administrator manages QRACKS itself.

Responsibilities include:

- Viewing all pools
- Monitoring activity
- Managing payment status
- Managing platform configuration
- Supporting administrators when needed

---

# 5. Core Concepts

## Pool

A private competition.

Each pool has:

- Name
- League
- Season
- Administrator
- Participants
- Matchdays

---

## Matchday

A group of matches.

Each matchday contains:

- Fixtures
- Deadline
- Official results
- Participant predictions

---

## Prediction

A participant's expected result for one match.

Predictions remain editable until the deadline.

---

## Deadline

The exact moment predictions become locked.

Deadlines are validated by the server.

---

## Standings

The leaderboard is automatically calculated after results are published.

---

# 6. User Journey

1. Create a pool.
2. Configure league and season.
3. Invite participants.
4. Participants join using the shared link.
5. Each participant creates a PIN.
6. Participants submit predictions.
7. Deadline expires.
8. Organizer records official results.
9. Results are published.
10. QRACKS updates the leaderboard.
11. Tournament history is preserved.

---

# 7. Participant Experience

Participants can:

- Join a pool
- Create a PIN
- Log in
- Submit predictions
- Edit predictions before deadline
- View countdown
- Follow standings
- View previous matchdays
- Review tournament history
- Switch participant on shared devices

Participants cannot:

- View hidden predictions
- Modify results
- Modify deadlines
- Manage other users

---

# 8. Pool Administrator Experience

Administrators can:

- Create matchdays
- Edit matchdays
- Select teams
- Configure deadlines
- Add participants
- Remove participants
- Rename participants
- Reset participant PINs
- Generate reminder messages
- Record results
- Publish results
- Close tournaments

Administrators cannot see participant predictions before publication.

---

# 9. Platform Administration

The platform dashboard provides:

- Pool overview
- Payment status
- Exemption status
- Activity monitoring
- Platform configuration

This dashboard is private.

---

# 10. Competition Rules

Predictions lock automatically at the configured deadline.

Only published results affect the standings.

Draft results remain invisible.

Scores cannot be recalculated from incomplete results.

Historical tournaments remain immutable after closing.

---

# 11. Supported Competitions

Current league support includes:

- Liga MX
- Premier League
- La Liga
- Bundesliga
- Serie A
- Ligue 1
- UEFA Champions League

Additional competitions can be supported in the future.

---

# 12. Security & Privacy

QRACKS protects competition integrity by:

- Hashing participant PINs
- Hashing administrator passwords
- Hiding predictions before publication
- Enforcing deadlines on the server
- Invalidating sessions after PIN reset

QRACKS never stores or distributes prize money.

---

# 13. Current Scope

Current priorities are:

- Product reliability
- Administrator experience
- Mobile usability
- Accessibility
- Performance
- Growth toward the first 100 active pools

---

# 14. Out of Scope

QRACKS currently does not include:

- Prize money management
- Sports betting
- Payment processing
- Public tournaments
- Native mobile applications

---

# 15. Future Evolution

Future versions may include:

- Additional sports
- Enhanced tournament formats
- Improved onboarding
- Monetization options
- Analytics
- Notifications

Future features will only be added if they preserve the product principles described in this document.
