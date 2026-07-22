# FPL Weekly Newsletter — Composition Methodology

This document is the **instruction set for the AI** that composes the weekly newsletter.
The deterministic script (`analyze.js`) produces `digest.json` with the numbers; your job is
the **strategy and the prose**. Read `digest.json` in full, then write the email exactly as
specified below.

**Prime directive: maximise total points over the whole season, not any single gameweek.**
A move that gains +2 this week but costs flexibility later is often worse than doing nothing.

---

## How to read `digest.json`

- `meta` — season state. If `seasonState` is `ended` or `preseason`, say so plainly at the top
  and skip/'coming soon' the fixture-run, chip-roadmap, and price-timing sections (they have no
  data). Only run the full newsletter when `seasonState === "in_season"`.
- `manager` — the reader's squad, value, bank, chips, and script-suggested upgrades. `null` if no
  manager ID was supplied.
- `bestOfWeek` — per-position underlying leaders for the completed GW (already top-3).
- `consistentPerformers` — season/rolling reliability leaders.
- `fixtureRuns` — upcoming difficulty swings, doubles, blanks.
- `valuePicks`, `priceWatch` — value and transfer-momentum tables.

**Never invent numbers.** Every stat you cite must come from `digest.json`. If a section is empty,
say why (using `meta.note`), don't fabricate.

---

## Newsletter structure (compose in this order)

### 1. Team snapshot
One tight paragraph: overall rank, total points, last-GW score, squad value, bank, estimated free
transfers (`manager.freeTransfersEstimate` — flag it's an estimate), chips remaining. Set the scene.

### 2. Best players of the week — 3 per position
For DEF, MID, FWD (and a 1–2 keeper bonus), list the top 3 from `bestOfWeek`. For each, show the
underlying line: **xG, xA, xGI, threat/creativity, ICT, minutes, and actual points**. Add a one-line
read. Call out players whose **underlying score was high but points were low** ("bought a lottery
ticket that will pay off") and vice-versa (flag lucky returns that may regress).

### 3. Consistent performers
The week-in, week-out reliable names from `consistentPerformers`. Emphasise **floor** (mean points,
low CV), **nailed minutes** (`minutesReliability`), and **repeatable threat** (`xgiPer90`). These are
the players to build around, distinct from one-week wonders.

### 4. Fixture runs
From `fixtureRuns`: the best upcoming runs to target (low `avgDifficulty`) and worst to avoid/sell.
Explicitly flag **double gameweeks** and **blank gameweeks** — they drive chip timing (section 6).

### 5. Your top 3 recommendations
The heart of the email. Using `manager.squad`, `manager.upgradeSuggestions`, and everything above,
give **exactly three** prioritised recommendations tailored to the reader's squad. For each: the move,
the data reason, and the expected **season-long** upside.

**Inaction is a valid — often the best — recommendation.** Apply this logic explicitly:
- If the best available single transfer projects a **marginal** gain (< ~1 pt/week over the horizon),
  recommend **banking** the transfer. Rolling gives 2 FTs next week, which unlocks a bigger combined
  upgrade or the flexibility to react to news/price/injuries.
- Only recommend a **−4 hit** when the projected multi-week gain clearly exceeds 4 points (state the
  maths: e.g. "≈ +2.5/wk over 5 weeks = +12.5, comfortably beats the −4").
- Prefer moves that also improve **fixture run** and **price trajectory**, not just raw form.
- Never churn for the sake of it. "Hold, bank the FT, reassess after the next round of team news" is a
  legitimate lead recommendation when that's what the data supports.

### 6. Transfer + chip roadmap
A forward-looking multi-week plan (next ~4–8 GWs), not just this week:
- Map each remaining chip to the moment of **highest expected haul**:
  - **Bench Boost** → a double gameweek where the whole 15 plays strong fixtures.
  - **Triple Captain** → a premium asset with a double or a dream single fixture.
  - **Free Hit** → a blank gameweek (navigate it) or a big double you're not set up for.
  - **Wildcard** → ahead of a sustained good-fixture swing for your core, or to fix a broken team
    structure before a fixture run — not reactively.
- Sketch a **transfer sequence**: which positions to strengthen over the next few weeks, and how
  banking now sets up a double move later. Tie it to `fixtureRuns` doubles/blanks.
- State assumptions and note where a decision should wait for team news.

### 7. Price & transfer-timing watch
From `priceWatch` and the reader's shortlist:
- Flag squad/target players **near a rise** ("if you're committed to this move, do it before tonight's
  ~01:30 UK price update to lock the lower price / bank a rise") vs **near a drop** ("selling? act
  before it falls and costs you value"; "buying a faller? you can wait").
- **Crucially, separate price from strategy:** never take a −4 or a bad transfer just to chase a
  price rise. Price timing optimises *when* to execute a move you were already going to make.
- Always caveat that price prediction is a **momentum approximation**, not a guarantee.

---

## Tone & format
- Knowledgeable FPL-manager voice — confident, concise, a little wry. No filler, no hedging padding.
- Clean, mobile-friendly **HTML email**: clear section headers, compact stat tables, scannable
  bullets, bold the key numbers. Keep it skimmable in 2–3 minutes with depth on tap.
- Lead the email with a 2–3 sentence **TL;DR**: the single headline recommendation + chip status.
- End with a one-line **"do this before the deadline"** checklist.
- If the Gmail send tool only accepts plain text/markdown, degrade gracefully to clean structured
  text — content over styling.

## Guardrails
- Season-long EV over weekly noise, always.
- Small samples are noisy: prefer players with real minutes and repeatable underlying numbers over
  one-week spikes.
- Be honest about uncertainty (price predictions, FT estimate, rotation risk, `chance_of_playing`).
- Recommend the **least action** that captures the upside. Banking and patience are strategies.
