# fpl-newsletter

A weekly Fantasy Premier League newsletter engine. A zero-dependency Node script pulls the official
(public) FPL API, computes the best players by **underlying data** (xG, xA, xGI, ICT, defensive
contribution), consistency, fixture runs, value, and transfer-price momentum, and writes a structured
`digest.json`. A weekly Claude Code cloud agent then reasons over that digest and emails a tailored
newsletter — per-position best-of-week, personalised recommendations, and a transfer + chip roadmap
aimed at maximising **season-long** points.

## How it works

```
FPL API ──► analyze.js ──► digest.json ──► AI (cloud agent) ──► HTML email (Gmail)
            (deterministic stats)           (strategy + prose, per METHODOLOGY.md)
```

The script does the number-crunching (reliable, repeatable); the AI does the judgement (which is
where the value is). `METHODOLOGY.md` is the AI's composition spec.

## Usage

Requires **Node 18+** (uses built-in `fetch`). No `npm install` needed.

```bash
node analyze.js <managerId>   # your FPL Manager ID (from fantasy.premierleague.com/entry/XXXXXX/...)
node analyze.js               # league-wide digest, no personal squad section
```

Writes `digest.json` in the repo root and prints a summary.

## Files

| File | Purpose |
|------|---------|
| `fetch.js` | Zero-dep FPL API client with a 30-min disk cache and season-aware gameweek detection. |
| `scoring.js` | Pure ranking/statistics helpers (best-of-week, consistency, fixture runs, price pressure). |
| `analyze.js` | Orchestrates fetch + scoring into `digest.json`. |
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
