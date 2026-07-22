# fpl-newsletter

A weekly Fantasy Premier League newsletter. Node scripts pull the official (public) FPL API, compute
the best players by **underlying data** (xG, xA, xGI, ICT, defensive contribution), consistency,
fixture runs, value, and transfer-price momentum, then Claude composes a tailored newsletter —
per-position best-of-week, personalised recommendations, and a transfer + chip roadmap aimed at
maximising **season-long** points — and it's emailed to you.

## How it works

The whole pipeline runs weekly on **GitHub Actions** (open internet, visible logs):

```
analyze.js ──► digest.json ──► compose.js ──► newsletter.html ──► send-email.js ──► your inbox
(FPL API,      (the numbers)   (Claude API,   (finished email)    (Gmail SMTP)
 deterministic)                per METHODOLOGY.md)
```

The scripts do the number-crunching (reliable, repeatable); Claude does the judgement (where the
value is). `METHODOLOGY.md` is the composition spec.

> Note: this replaced an earlier design that ran composition in a Claude Code **cloud routine**. That
> routine's sandbox is blocked from the FPL API by an org egress policy and its run logs aren't
> externally visible, so the whole pipeline was moved to GitHub Actions where the network is open and
> every run is inspectable in the Actions tab.

## Weekly automation (GitHub Actions)

Workflow: [`.github/workflows/fpl-newsletter.yml`](.github/workflows/fpl-newsletter.yml). Runs
Tuesday 07:00 UTC; also runnable on demand via **Actions → FPL Newsletter → Run workflow**.

**Required repo secrets** (Settings → Secrets and variables → Actions → New repository secret):

| Secret | What |
|--------|------|
| `ANTHROPIC_API_KEY` | Claude API key (console.anthropic.com) — used by `compose.js`. |
| `GMAIL_ADDRESS` | The Gmail address the email is sent from. |
| `GMAIL_APP_PASSWORD` | A Gmail **App Password** (myaccount.google.com/apppasswords; requires 2-Step Verification). |
| `RECIPIENT` | Optional — where to send it. Defaults to `GMAIL_ADDRESS`. |

Also set **Settings → Actions → General → Workflow permissions → Read and write** so the run can
commit the refreshed `digest.json`. The composed email is also uploaded as a downloadable
`newsletter-html` artifact on every run.

## Local usage

Requires **Node 18+** (built-in `fetch`).

```bash
node analyze.js <managerId>   # FPL Manager ID (from fantasy.premierleague.com/entry/XXXXXX/...) -> digest.json
npm install                   # once, for nodemailer (only needed for send-email.js)
ANTHROPIC_API_KEY=... node compose.js                       # digest.json -> newsletter.html
GMAIL_ADDRESS=... GMAIL_APP_PASSWORD=... node send-email.js  # emails newsletter.html
```

`analyze.js` writes `digest.json` and prints a summary. `node analyze.js` with no ID produces a
league-wide digest with no personal squad section.

## Files

| File | Purpose |
|------|---------|
| `fetch.js` | Zero-dep FPL API client with a 30-min disk cache and season-aware gameweek detection. |
| `scoring.js` | Pure ranking/statistics helpers (best-of-week, consistency, fixture runs, price pressure). |
| `analyze.js` | Orchestrates fetch + scoring into `digest.json`. |
| `compose.js` | Sends `digest.json` + `METHODOLOGY.md` to the Claude API; writes `newsletter.html`. |
| `send-email.js` | Emails `newsletter.html` via Gmail SMTP (nodemailer). |
| `METHODOLOGY.md` | Instruction set for the AI that composes the newsletter. |

## Data sources (all public, no key)

- `bootstrap-static/` — players, teams, positions, events, season xG/xA/xGI, prices, ownership, transfers.
- `fixtures/` — fixtures + difficulty (fixture runs, doubles, blanks).
- `event/{gw}/live/` — per-gameweek underlying stats (best-of-week, rolling consistency window).
- `entry/{id}/…` — the reader's squad, value, bank, chips, history.

## Notes & limitations

- **Season-aware:** between seasons / pre-season, fixture-run, chip, and price sections are empty by
  design (no fixtures published yet); best-of-week and consistency use the last completed season.
- **Price prediction** is a momentum approximation from public net-transfer counts, not the exact
  (proprietary) FPL algorithm.
- **Free transfers / current live team:** the confirmed squad from the last deadline is read without
  auth; the exact free-transfer count and unsubmitted pre-deadline edits would require authenticated
  `my-team` access and are estimated/omitted.
