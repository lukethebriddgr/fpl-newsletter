// analyze.js — orchestrates the FPL fetch + scoring into a single digest.json.
// Usage: node analyze.js <managerId>   (managerId optional; omit for league-wide digest)

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getBootstrap,
  getFixtures,
  getEventLive,
  getEntry,
  getEntryHistory,
  getEntryPicks,
  resolveGameweeks,
} from "./fetch.js";
import {
  POS,
  rankBestOfWeek,
  consistencyMetrics,
  consistencyScore,
  teamFixtureRuns,
  detectBlanksAndDoubles,
  pricePressure,
  round,
  num,
} from "./scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECENT_WINDOW = 8; // gameweeks used for form/consistency
const FIXTURE_HORIZON = 5; // gameweeks ahead for fixture-run analysis
const MIN_SEASON_MINUTES = 450; // ~5 full matches, to filter out noise
const TOP_N = 3; // recommendations per position

// Standard chip allotment assumption (varies by season — flagged in output).
const CHIP_ASSUMPTION = { wildcard: 2, bboost: 2, "3xc": 2, freehit: 2 };

async function main() {
  const managerId = process.argv[2] ? String(process.argv[2]).trim() : null;

  const [bootstrap, fixtures] = await Promise.all([getBootstrap(), getFixtures()]);
  const gw = resolveGameweeks(bootstrap.events);

  const teams = indexBy(bootstrap.teams, "id");
  const players = indexBy(bootstrap.elements, "id");

  // --- Recent per-player matrix (form + consistency) -----------------------
  const finishedGws = bootstrap.events.filter((e) => e.finished).map((e) => e.id);
  const windowGws = finishedGws.slice(-RECENT_WINDOW);
  const recent = await buildRecentMatrix(windowGws);

  // --- Section 1: Best of the just-completed gameweek ----------------------
  const bestOfWeek = await buildBestOfWeek(gw.lastFinishedGw, players, teams);

  // --- Section 2: Consistent performers ------------------------------------
  const consistentPerformers = buildConsistency(bootstrap.elements, recent, teams);

  // --- Section 3: Fixture runs ---------------------------------------------
  const fixtureRuns = buildFixtureRuns(fixtures, gw.nextGw, teams);

  // --- Section 4: Value picks ----------------------------------------------
  const valuePicks = buildValue(bootstrap.elements, teams);

  // --- Section 5/6: Squad + price watch ------------------------------------
  const fixtureAvgByTeam = new Map(
    [...teamFixtureRuns(fixtures, gw.nextGw, FIXTURE_HORIZON)].map(([t, r]) => [t, r.avgDifficulty])
  );
  const manager = managerId
    ? await buildSquad(managerId, gw, bootstrap, players, teams, recent, fixtureAvgByTeam)
    : null;

  const priceWatch = buildPriceWatch(bootstrap.elements, teams);

  // --- Player image/index (for the renderer's photos + badges) -------------
  const playerIndex = buildPlayerIndex(
    { bestOfWeek, consistentPerformers, valuePicks, priceWatch, manager },
    players,
    teams
  );

  const digest = {
    meta: {
      generatedAt: new Date().toISOString(),
      dataSource: "Official FPL API (public)",
      season: bootstrap.events?.[0]?.deadline_time?.slice(0, 4)
        ? `${bootstrap.events[0].deadline_time.slice(0, 4)}/${Number(bootstrap.events[0].deadline_time.slice(2, 4)) + 1}`
        : "unknown",
      seasonState: gw.seasonState,
      lastFinishedGw: gw.lastFinishedGw,
      nextGw: gw.nextGw,
      recentWindowGws: windowGws,
      note:
        gw.seasonState === "ended"
          ? "Season has ended — fixture-run and upcoming-deadline sections are empty until next season's fixtures publish. Best-of-week and consistency reflect the completed season."
          : gw.seasonState === "preseason"
          ? "Pre-season — no completed gameweeks yet."
          : null,
    },
    manager,
    bestOfWeek,
    consistentPerformers,
    fixtureRuns,
    valuePicks,
    priceWatch,
    playerIndex,
  };

  const outPath = path.join(__dirname, "digest.json");
  await writeFile(outPath, JSON.stringify(digest, null, 2));
  printSummary(digest, outPath);
}

// --- builders ---------------------------------------------------------------

async function buildRecentMatrix(windowGws) {
  const byEl = new Map();
  for (const g of windowGws) {
    const live = await getEventLive(g);
    if (!live?.elements) continue;
    for (const e of live.elements) {
      if (!byEl.has(e.id)) byEl.set(e.id, []);
      byEl.get(e.id).push({
        gw: g,
        points: num(e.stats.total_points),
        minutes: num(e.stats.minutes),
        xgi: num(e.stats.expected_goal_involvements),
      });
    }
  }
  return byEl;
}

async function buildBestOfWeek(lastGw, players, teams) {
  if (lastGw == null) return { gw: null, GKP: [], DEF: [], MID: [], FWD: [] };
  const live = await getEventLive(lastGw);
  if (!live?.elements) return { gw: lastGw, GKP: [], DEF: [], MID: [], FWD: [] };

  const rows = live.elements
    .map((e) => {
      const p = players.get(e.id);
      if (!p) return null;
      return { ...e.stats, id: e.id, element_type: p.element_type };
    })
    .filter(Boolean);

  const ranked = rankBestOfWeek(rows);
  const shape = (arr) =>
    arr.slice(0, TOP_N).map((r) => presentWeekly(r, players.get(r.id), teams));
  return {
    gw: lastGw,
    GKP: shape(ranked.GKP).slice(0, 2), // keepers as a short bonus list
    DEF: shape(ranked.DEF),
    MID: shape(ranked.MID),
    FWD: shape(ranked.FWD),
  };
}

function buildConsistency(elements, recent, teams) {
  const rows = [];
  for (const p of elements) {
    if (num(p.minutes) < MIN_SEASON_MINUTES) continue;
    const weeks = recent.get(p.id) || [];
    if (!weeks.length) continue;
    const m = consistencyMetrics(weeks);
    rows.push({
      id: p.id,
      name: p.web_name,
      team: teams.get(p.team)?.short_name,
      position: POS[p.element_type],
      price: round(p.now_cost / 10, 1),
      seasonPoints: num(p.total_points),
      pointsPerGame: num(p.points_per_game),
      selectedBy: num(p.selected_by_percent),
      ...m,
      reliability: consistencyScore(m),
    });
  }
  return rows.sort((a, b) => b.reliability - a.reliability).slice(0, 15);
}

function buildFixtureRuns(fixtures, nextGw, teams) {
  if (nextGw == null) {
    return {
      horizon: FIXTURE_HORIZON,
      available: false,
      note: "No upcoming fixtures published yet (between seasons or pre-season).",
      bestRuns: [],
      worstRuns: [],
      doubleGameweeks: [],
      blankGameweeks: [],
    };
  }
  const runs = teamFixtureRuns(fixtures, nextGw, FIXTURE_HORIZON);
  const list = [...runs.entries()].map(([teamId, r]) => ({
    team: teams.get(teamId)?.short_name,
    teamId,
    count: r.count,
    avgDifficulty: r.avgDifficulty,
    doubleGws: r.doubleGws,
    fixtures: r.fixtures.map((f) => ({
      gw: f.gw,
      opp: teams.get(f.opp)?.short_name,
      venue: f.home ? "H" : "A",
      difficulty: f.difficulty,
    })),
  }));
  const rated = list.filter((x) => x.avgDifficulty != null);
  const { doubleGameweeks, blankGameweeks } = detectBlanksAndDoubles(
    fixtures,
    nextGw,
    FIXTURE_HORIZON,
    teams.size
  );
  return {
    horizon: FIXTURE_HORIZON,
    available: true,
    fromGw: nextGw,
    bestRuns: [...rated].sort((a, b) => a.avgDifficulty - b.avgDifficulty).slice(0, 6),
    worstRuns: [...rated].sort((a, b) => b.avgDifficulty - a.avgDifficulty).slice(0, 4),
    doubleGameweeks,
    blankGameweeks,
  };
}

function buildValue(elements, teams) {
  const pool = elements
    .filter((p) => num(p.minutes) >= MIN_SEASON_MINUTES)
    .map((p) => {
      const priceM = p.now_cost / 10;
      return {
        id: p.id,
        name: p.web_name,
        team: teams.get(p.team)?.short_name,
        position: POS[p.element_type],
        price: round(priceM, 1),
        seasonPoints: num(p.total_points),
        xgi: round(num(p.expected_goal_involvements), 2),
        pointsPerM: round(num(p.total_points) / priceM, 2),
        xgiPerM: round(num(p.expected_goal_involvements) / priceM, 3),
      };
    });
  return {
    byPointsPerM: [...pool].sort((a, b) => b.pointsPerM - a.pointsPerM).slice(0, 10),
    byXgiPerM: [...pool].sort((a, b) => b.xgiPerM - a.xgiPerM).slice(0, 10),
  };
}

function buildPriceWatch(elements, teams) {
  const scored = elements
    .filter((p) => num(p.selected_by_percent) >= 1) // ignore obscure names
    .map((p) => ({
      id: p.id,
      name: p.web_name,
      team: teams.get(p.team)?.short_name,
      position: POS[p.element_type],
      price: round(p.now_cost / 10, 1),
      selectedBy: num(p.selected_by_percent),
      ...pricePressure(p),
    }));
  return {
    note: "Momentum approximation from public net transfers — directional, not the exact FPL threshold. Prices change ~01:30 UK daily.",
    risers: scored
      .filter((x) => x.signal === "rising")
      .sort((a, b) => b.netTransfers - a.netTransfers)
      .slice(0, 10),
    fallers: scored
      .filter((x) => x.signal === "falling")
      .sort((a, b) => a.netTransfers - b.netTransfers)
      .slice(0, 10),
  };
}

async function buildSquad(managerId, gw, bootstrap, players, teams, recent, fixtureAvgByTeam) {
  const pickGw = gw.currentGw || gw.lastFinishedGw;
  const [entry, history, picks] = await Promise.all([
    getEntry(managerId),
    getEntryHistory(managerId),
    pickGw ? getEntryPicks(managerId, pickGw) : Promise.resolve(null),
  ]);
  if (!entry) return { id: managerId, error: "Manager not found or no data yet." };

  const chipsUsed = (history?.chips || []).map((c) => ({ chip: c.name, gw: c.event }));
  const usedCounts = chipsUsed.reduce((acc, c) => ((acc[c.chip] = (acc[c.chip] || 0) + 1), acc), {});
  const chipsRemaining = Object.fromEntries(
    Object.entries(CHIP_ASSUMPTION).map(([c, total]) => [c, total - (usedCounts[c] || 0)])
  );

  // Free-transfer estimate: without authenticated my-team we infer from last GW activity.
  const lastEvent = (history?.current || []).slice(-1)[0];
  const ftEstimate = lastEvent && num(lastEvent.event_transfers) === 0 ? 2 : 1;

  const squad = (picks?.picks || []).map((pk) => {
    const p = players.get(pk.element);
    const weeks = recent.get(pk.element) || [];
    const m = weeks.length ? consistencyMetrics(weeks) : null;
    const teamRun = fixtureAvgByTeam.get(p?.team);
    return {
      id: pk.element,
      name: p?.web_name,
      team: teams.get(p?.team)?.short_name,
      position: POS[p?.element_type],
      price: p ? round(p.now_cost / 10, 1) : null,
      isCaptain: pk.is_captain,
      isVice: pk.is_vice_captain,
      multiplier: pk.multiplier,
      onBench: pk.position > 11,
      form: p ? num(p.form) : null,
      seasonPoints: p ? num(p.total_points) : null,
      recentMeanPoints: m?.meanPoints ?? null,
      xgiPer90: m?.xgiPer90 ?? null,
      minutesReliability: m?.minutesReliability ?? null,
      status: p?.status,
      chanceNextRound: p?.chance_of_playing_next_round,
      nextFixturesAvgDifficulty: teamRun ?? null,
      projection: projectPlayer(p, m, teamRun),
    };
  });

  // Upgrade candidates: same position, affordable, higher projection than a squad player.
  const bankM = num(entry.last_deadline_bank) / 10;
  const upgradeSuggestions = buildUpgrades(squad, bootstrap.elements, players, teams, recent, fixtureAvgByTeam, bankM);

  return {
    id: managerId,
    name: `${entry.player_first_name} ${entry.player_last_name}`,
    teamName: entry.name,
    overallRank: entry.summary_overall_rank,
    totalPoints: entry.summary_overall_points,
    lastGwPoints: entry.summary_event_points,
    squadValue: round((num(entry.last_deadline_value)) / 10, 1),
    bank: round(bankM, 1),
    freeTransfersEstimate: ftEstimate,
    freeTransfersNote: "Estimated from last GW activity; exact FT requires authenticated my-team access.",
    chipsUsed,
    chipsRemaining,
    chipsNote: "Remaining assumes a standard 2-of-each allotment; confirm against your season's chip rules.",
    pickGw,
    squad,
    upgradeSuggestions,
  };
}

function buildUpgrades(squad, elements, players, teams, recent, fixtureAvgByTeam, bankM) {
  const suggestions = [];
  for (const mine of squad) {
    if (!mine.price) continue;
    const budget = mine.price + bankM;
    const alternatives = elements
      .filter(
        (p) =>
          p.element_type === positionId(mine.position) &&
          p.id !== mine.id &&
          num(p.now_cost) / 10 <= budget + 0.05 &&
          num(p.minutes) >= MIN_SEASON_MINUTES &&
          p.status === "a"
      )
      .map((p) => {
        const m = recent.get(p.id)?.length ? consistencyMetrics(recent.get(p.id)) : null;
        return {
          id: p.id,
          name: p.web_name,
          team: teams.get(p.team)?.short_name,
          price: round(p.now_cost / 10, 1),
          projection: projectPlayer(p, m, fixtureAvgByTeam.get(p.team)),
        };
      })
      .filter((a) => a.projection > (mine.projection ?? -Infinity) + 0.5)
      .sort((a, b) => b.projection - a.projection)
      .slice(0, 3);
    if (alternatives.length) {
      suggestions.push({
        out: { id: mine.id, name: mine.name, position: mine.position, price: mine.price, projection: mine.projection },
        in: alternatives,
        projectionDelta: round(alternatives[0].projection - (mine.projection ?? 0), 2),
      });
    }
  }
  return suggestions.sort((a, b) => b.projectionDelta - a.projectionDelta).slice(0, 8);
}

// --- helpers ----------------------------------------------------------------

function projectPlayer(p, m, teamAvgDifficulty) {
  if (!p) return null;
  const recentMean = m?.meanPoints ?? num(p.form);
  const xgi90 = m?.xgiPer90 ?? 0;
  const nailed = m?.minutesReliability ?? 0.5;
  const diff = teamAvgDifficulty ?? 3;
  // Higher recent floor + underlying threat + nailed minutes, penalised by hard fixtures.
  return round(recentMean * 0.6 + xgi90 * 2 + nailed * 1.5 - (diff - 3) * 0.6, 2);
}

function presentWeekly(r, p, teams) {
  return {
    id: r.id,
    name: p?.web_name,
    team: teams.get(p?.team)?.short_name,
    position: POS[p?.element_type],
    price: p ? round(p.now_cost / 10, 1) : null,
    minutes: num(r.minutes),
    points: num(r.total_points),
    xg: round(num(r.expected_goals), 2),
    xa: round(num(r.expected_assists), 2),
    xgi: round(num(r.expected_goal_involvements), 2),
    xgc: round(num(r.expected_goals_conceded), 2),
    threat: round(num(r.threat), 1),
    creativity: round(num(r.creativity), 1),
    ict: round(num(r.ict_index), 1),
    bps: num(r.bps),
    bonus: num(r.bonus),
    defensiveContribution: num(r.defensive_contribution),
    saves: num(r.saves),
    underlyingScore: r.underlyingScore,
  };
}

function positionId(short) {
  return { GKP: 1, DEF: 2, MID: 3, FWD: 4 }[short];
}

// Compact lookup for every player referenced anywhere in the digest, so the
// renderer can draw photos/badges without carrying image fields on every object.
function buildPlayerIndex(sections, players, teams) {
  const ids = new Set();
  const add = (arr) => (arr || []).forEach((p) => p && p.id != null && ids.add(p.id));
  const b = sections.bestOfWeek || {};
  ["GKP", "DEF", "MID", "FWD"].forEach((k) => add(b[k]));
  add(sections.consistentPerformers);
  add(sections.valuePicks?.byPointsPerM);
  add(sections.valuePicks?.byXgiPerM);
  add(sections.priceWatch?.risers);
  add(sections.priceWatch?.fallers);
  if (sections.manager?.squad) {
    add(sections.manager.squad);
    (sections.manager.upgradeSuggestions || []).forEach((s) => {
      if (s.out?.id != null) ids.add(s.out.id);
      add(s.in);
    });
  }
  const index = {};
  for (const id of ids) {
    const p = players.get(id);
    if (!p) continue;
    const team = teams.get(p.team);
    index[id] = {
      name: p.web_name,
      code: p.code, // -> players/250x250/p{code}.png
      teamShort: team?.short_name,
      teamCode: team?.code, // -> badges/t{teamCode}.png
      position: POS[p.element_type],
      price: round(p.now_cost / 10, 1),
    };
  }
  return index;
}

function indexBy(arr, key) {
  const m = new Map();
  for (const x of arr) m.set(x[key], x);
  return m;
}

function printSummary(d, outPath) {
  const m = d.meta;
  console.log(`\n✔ digest.json written → ${outPath}`);
  console.log(`  Season ${m.season} · state=${m.seasonState} · lastGw=${m.lastFinishedGw} · nextGw=${m.nextGw}`);
  if (m.note) console.log(`  Note: ${m.note}`);
  const bow = d.bestOfWeek;
  if (bow.gw) {
    console.log(`\n  Best of GW${bow.gw}:`);
    for (const pos of ["DEF", "MID", "FWD"]) {
      const names = bow[pos].map((x) => `${x.name} (xGI ${x.xgi}, ${x.points}pts)`).join(", ");
      console.log(`    ${pos}: ${names}`);
    }
  }
  console.log(`\n  Consistent performers (top 5):`);
  d.consistentPerformers.slice(0, 5).forEach((c) =>
    console.log(`    ${c.name} (${c.position}, ${c.team}) — mean ${c.meanPoints}pts, xGI/90 ${c.xgiPer90}, reliab ${c.reliability}`)
  );
  if (d.manager && !d.manager.error) {
    console.log(`\n  Manager: ${d.manager.teamName} — ${d.manager.totalPoints} pts, rank ${d.manager.overallRank}`);
    console.log(`    Top upgrade: ${d.manager.upgradeSuggestions[0] ? `${d.manager.upgradeSuggestions[0].out.name} → ${d.manager.upgradeSuggestions[0].in[0].name} (Δ${d.manager.upgradeSuggestions[0].projectionDelta})` : "none suggested"}`);
  } else if (d.manager?.error) {
    console.log(`\n  Manager: ${d.manager.error}`);
  }
}

main().catch(async (err) => {
  console.error("analyze.js failed:", err.message || err);
  // Resilience: the FPL API periodically returns 503 "Game Updating" (nightly price
  // updates, off-season maintenance). If we already have a committed digest.json,
  // keep it (last-good data) and exit 0 so compose+email still run — the newsletter's
  // staleness check will flag that the data is old. Only hard-fail with no fallback.
  const { existsSync } = await import("node:fs");
  const digestPath = path.join(__dirname, "digest.json");
  if (existsSync(digestPath)) {
    console.error("→ FPL API unavailable; keeping the existing digest.json (last-good data) so the newsletter can still be produced.");
    process.exit(0);
  }
  console.error("→ No existing digest.json to fall back on. Failing.");
  process.exit(1);
});
