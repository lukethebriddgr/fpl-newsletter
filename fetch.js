// fetch.js — zero-dependency FPL API client with a light on-disk cache.
// Node 18+ (built-in global fetch). All endpoints are public/key-less.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".cache");
const BASE = "https://fantasy.premierleague.com/api";

// Cache lifetime: raw FPL data changes at most a few times a day. 30 min keeps
// re-runs inside one session fast without ever serving badly stale numbers.
const CACHE_TTL_MS = 30 * 60 * 1000;

async function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
}

function cacheKey(url) {
  return url.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") + ".json";
}

async function readCache(file) {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (Date.now() - raw.__ts < CACHE_TTL_MS) return raw.__data;
  } catch {
    /* miss */
  }
  return undefined;
}

/**
 * GET a URL as JSON, with a 30-minute disk cache and simple retry/backoff.
 * @param {string} pathname e.g. "bootstrap-static/"
 * @param {{noCache?: boolean}} [opts]
 */
export async function getJSON(pathname, opts = {}) {
  await ensureCacheDir();
  const url = `${BASE}/${pathname}`;
  const file = path.join(CACHE_DIR, cacheKey(pathname));

  if (!opts.noCache) {
    const hit = await readCache(file);
    if (hit !== undefined) return hit;
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          // FPL occasionally rejects the default Node UA; a browser-like UA is safe.
          "User-Agent":
            "Mozilla/5.0 (fpl-newsletter; +https://github.com/) Node",
          Accept: "application/json",
        },
      });
      if (res.status === 404) return null; // e.g. picks before a GW exists
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathname}`);
      const data = await res.json();
      await writeFile(file, JSON.stringify({ __ts: Date.now(), __data: data }));
      return data;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new Error(`Failed to fetch ${pathname}: ${lastErr?.message}`);
}

// --- Typed endpoint helpers -------------------------------------------------

export const getBootstrap = () => getJSON("bootstrap-static/");
export const getFixtures = () => getJSON("fixtures/");
export const getEventLive = (gw) => getJSON(`event/${gw}/live/`);
export const getElementSummary = (id) => getJSON(`element-summary/${id}/`);

export const getEntry = (id) => getJSON(`entry/${id}/`);
export const getEntryHistory = (id) => getJSON(`entry/${id}/history/`);
export const getEntryTransfers = (id) => getJSON(`entry/${id}/transfers/`);
export const getEntryPicks = (id, gw) =>
  getJSON(`entry/${id}/event/${gw}/picks/`);

/**
 * Work out where we are in the season from the events array.
 * Handles the between-seasons gap (season finished, next not yet live).
 * @param {Array} events bootstrap.events
 */
export function resolveGameweeks(events) {
  const finished = events.filter((e) => e.finished);
  const lastFinished = finished.length ? finished[finished.length - 1] : null;
  const current = events.find((e) => e.is_current) || lastFinished;
  const next = events.find((e) => e.is_next) || null;

  // Season is "between" when everything has finished and nothing is queued.
  const allFinished = events.every((e) => e.finished);
  const notStarted = !events.some((e) => e.finished) && !events.some((e) => e.is_current);

  return {
    lastFinishedGw: lastFinished ? lastFinished.id : null,
    currentGw: current ? current.id : null,
    nextGw: next ? next.id : null,
    seasonState: allFinished ? "ended" : notStarted ? "preseason" : "in_season",
  };
}
