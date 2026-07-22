// scoring.js — pure, testable ranking/statistics helpers. No I/O.

export const POS = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** Standard-score an array; returns all-zeros if there's no spread. */
export function zScores(values) {
  const n = values.length;
  if (!n) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  if (sd === 0) return values.map(() => 0);
  return values.map((v) => (v - mean) / sd);
}

/** Weighted sum of pre-computed z-score columns keyed by metric. */
function weightedZ(rows, weights) {
  const cols = {};
  for (const key of Object.keys(weights)) {
    cols[key] = zScores(rows.map((r) => r[key] ?? 0));
  }
  return rows.map((_, i) =>
    Object.entries(weights).reduce((acc, [k, w]) => acc + w * cols[k][i], 0)
  );
}

// Per-position weights for the single-gameweek "played well" score. Rewards
// underlying process (xGI, threat, defensive work) over the actual points blip.
const WEEKLY_WEIGHTS = {
  GKP: { saves: 0.3, bps: 0.3, cleanSheetProxy: 0.3, ict: 0.1 },
  DEF: { xgi: 0.3, defcon: 0.2, bps: 0.25, cleanSheetProxy: 0.15, threat: 0.1 },
  MID: { xgi: 0.45, threat: 0.15, creativity: 0.1, bps: 0.2, defcon: 0.1 },
  FWD: { xgi: 0.5, threat: 0.2, creativity: 0.1, bps: 0.2 },
};

/**
 * Rank a single completed gameweek's best players per position by underlying data.
 * @param {Array} liveRows rows joined from event/{gw}/live + bootstrap element
 *   Each needs: element_type, minutes, expected_goals, expected_assists,
 *   expected_goal_involvements, expected_goals_conceded, threat, creativity,
 *   ict_index, bps, saves, defensive_contribution, total_points (this GW).
 * @param {number} minMinutes eligibility gate
 * @returns {{GKP:Array, DEF:Array, MID:Array, FWD:Array}}
 */
export function rankBestOfWeek(liveRows, minMinutes = 45) {
  const out = { GKP: [], DEF: [], MID: [], FWD: [] };
  for (const posId of [1, 2, 3, 4]) {
    const posName = POS[posId];
    const eligible = liveRows.filter(
      (r) => r.element_type === posId && num(r.minutes) >= minMinutes
    );
    if (!eligible.length) continue;

    // xGC is "bad", so invert into a clean-sheet-likelihood proxy.
    const maxXgc = Math.max(...eligible.map((r) => num(r.expected_goals_conceded)), 0.01);
    const rows = eligible.map((r) => ({
      ref: r,
      xgi: num(r.expected_goal_involvements),
      threat: num(r.threat),
      creativity: num(r.creativity),
      ict: num(r.ict_index),
      bps: num(r.bps),
      saves: num(r.saves),
      defcon: num(r.defensive_contribution),
      cleanSheetProxy: maxXgc - num(r.expected_goals_conceded),
    }));

    const scores = weightedZ(rows, WEEKLY_WEIGHTS[posName]);
    out[posName] = rows
      .map((row, i) => ({ ...row.ref, underlyingScore: round(scores[i], 3) }))
      .sort((a, b) => b.underlyingScore - a.underlyingScore);
  }
  return out;
}

/**
 * Consistency over a recent window of gameweeks.
 * @param {Array<{points:number, minutes:number, xgi:number}>} weeks per-GW rows
 * @returns metrics describing floor/reliability
 */
export function consistencyMetrics(weeks) {
  const played = weeks.filter((w) => w.minutes > 0);
  const n = weeks.length || 1;
  const points = weeks.map((w) => w.points);
  const mean = points.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(points.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const totalMinutes = weeks.reduce((a, w) => a + w.minutes, 0);
  const starts = weeks.filter((w) => w.minutes >= 60).length;
  return {
    windowGws: weeks.length,
    meanPoints: round(mean, 2),
    // Coefficient of variation: lower = steadier. Guard against divide-by-zero.
    cv: mean > 0 ? round(sd / mean, 2) : null,
    returns6: weeks.filter((w) => w.points >= 6).length, // hauls
    blanks: weeks.filter((w) => w.minutes > 0 && w.points <= 2).length,
    minutesReliability: round(starts / n, 2),
    avgMinutes: Math.round(totalMinutes / n),
    xgiPer90: totalMinutes > 0
      ? round((weeks.reduce((a, w) => a + w.xgi, 0) / totalMinutes) * 90, 2)
      : 0,
    appearances: played.length,
  };
}

/** Blend recent consistency into a single sortable "reliability" score. */
export function consistencyScore(m) {
  if (!m.appearances) return -Infinity;
  const floor = m.meanPoints; // high average
  const steadiness = m.cv == null ? 0 : Math.max(0, 1 - m.cv); // lower CV better
  const nailed = m.minutesReliability; // plays big minutes
  const threat = m.xgiPer90; // creates/takes chances
  return round(floor * 1.0 + steadiness * 4 + nailed * 3 + threat * 3, 3);
}

/**
 * Fixture-run difficulty for each team over the next N unfinished fixtures.
 * @param {Array} fixtures fixtures endpoint
 * @param {number} fromGw first upcoming gameweek to consider
 * @param {number} horizon how many gameweeks ahead
 * @returns Map teamId -> { fixtures:[{gw,opp,home,difficulty}], avgDifficulty, count }
 */
export function teamFixtureRuns(fixtures, fromGw, horizon = 5) {
  const runs = new Map();
  if (fromGw == null) return runs;
  const window = fixtures.filter(
    (f) => f.event != null && f.event >= fromGw && f.event < fromGw + horizon && !f.finished
  );
  const add = (teamId, gw, oppId, home, difficulty) => {
    if (!runs.has(teamId)) runs.set(teamId, { fixtures: [], perGw: {} });
    const r = runs.get(teamId);
    r.fixtures.push({ gw, opp: oppId, home, difficulty });
    r.perGw[gw] = (r.perGw[gw] || 0) + 1;
  };
  for (const f of window) {
    add(f.team_h, f.event, f.team_a, true, f.team_h_difficulty);
    add(f.team_a, f.event, f.team_h, false, f.team_a_difficulty);
  }
  for (const r of runs.values()) {
    const diffs = r.fixtures.map((x) => x.difficulty);
    r.count = r.fixtures.length;
    r.avgDifficulty = diffs.length
      ? round(diffs.reduce((a, b) => a + b, 0) / diffs.length, 2)
      : null;
    // A gameweek within the horizon in which this team has 2 fixtures = double.
    r.doubleGws = Object.entries(r.perGw)
      .filter(([, c]) => c >= 2)
      .map(([gw]) => Number(gw));
  }
  return runs;
}

/** Detect blank gameweeks (fewer than the full 20 teams playing) in a window. */
export function detectBlanksAndDoubles(fixtures, fromGw, horizon, teamCount = 20) {
  const result = { doubleGameweeks: [], blankGameweeks: [] };
  if (fromGw == null) return result;
  for (let gw = fromGw; gw < fromGw + horizon; gw++) {
    const fx = fixtures.filter((f) => f.event === gw);
    if (!fx.length) continue;
    const teamsPlaying = new Set();
    let doubleTeams = 0;
    const counts = {};
    for (const f of fx) {
      counts[f.team_h] = (counts[f.team_h] || 0) + 1;
      counts[f.team_a] = (counts[f.team_a] || 0) + 1;
      teamsPlaying.add(f.team_h);
      teamsPlaying.add(f.team_a);
    }
    doubleTeams = Object.values(counts).filter((c) => c >= 2).length;
    if (doubleTeams > 0) result.doubleGameweeks.push({ gw, doubleTeams });
    if (teamsPlaying.size < teamCount)
      result.blankGameweeks.push({ gw, teamsPlaying: teamsPlaying.size });
  }
  return result;
}

/** Momentum-based price pressure from public transfer counts. Approximation. */
export function pricePressure(el) {
  const inE = num(el.transfers_in_event);
  const outE = num(el.transfers_out_event);
  const net = inE - outE;
  // Direction guidance; magnitude is relative, not the exact FPL threshold.
  let signal = "stable";
  if (net > 30000 && num(el.cost_change_event) <= 0) signal = "rising";
  else if (net < -30000 && num(el.cost_change_event) >= 0) signal = "falling";
  return {
    netTransfers: net,
    transfersIn: inE,
    transfersOut: outE,
    costChangeEvent: num(el.cost_change_event),
    costChangeStart: num(el.cost_change_start),
    signal,
  };
}

export function round(v, dp = 2) {
  const f = 10 ** dp;
  return Math.round(num(v) * f) / f;
}

export { num };
