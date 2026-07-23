// news.js — pre-season / between-seasons NEWS digest.
//
// Pulls a curated set of football RSS feeds, extracts recent items, and asks
// Claude (forced tool call → pre-parsed structured output) to filter and rank
// them by *FPL relevance* — transfers in/out, manager changes, injuries/returns,
// pre-season friendlies, nailed starters, penalty/set-piece changes — each with a
// one-line "why this matters for your team." render.js owns all HTML (a `news`
// section type). If the API fails, a deterministic fallback still ships a digest.
//
// Zero deps (built-in fetch). Needs ANTHROPIC_API_KEY. Invoked by compose.js when
// the season is pre-season / ended (see the mode switch there); can also run alone.

import "./load-env.js";
import { readFile, writeFile } from "node:fs/promises";
import { renderNewsletter } from "./render.js";

const MODEL = process.env.NEWSLETTER_MODEL || "claude-sonnet-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Curated feeds. FFS is the most FPL-native; the others give transfer/manager/
// injury coverage. All confirmed returning RSS <item>s (PL official has no feed).
const FEEDS = [
  { name: "Fantasy Football Scout", url: "https://www.fantasyfootballscout.co.uk/feed" },
  { name: "BBC Sport", url: "https://feeds.bbci.co.uk/sport/football/rss.xml" },
  { name: "Sky Sports PL", url: "https://www.skysports.com/rss/12040" },
  { name: "The Guardian", url: "https://www.theguardian.com/football/rss" },
];

const MAX_AGE_DAYS = 14; // pre-season moves slowly; a fortnight keeps it substantial
const MAX_ITEMS = 60; // cap what we hand the model

// --- tiny RSS parser (handles CDATA + entities; no deps) --------------------
const stripCdata = (s) =>
  String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .trim();

const decodeEntities = (s) =>
  String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(stripCdata(m[1])) : "";
}

function parseRss(xml, source) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = stripTags(tag(b, "title"));
    if (!title) continue;
    const link = stripTags(tag(b, "link"));
    const pub = tag(b, "pubDate") || tag(b, "dc:date");
    const desc = stripTags(tag(b, "description")).slice(0, 400);
    const ts = pub ? Date.parse(pub) : NaN;
    items.push({ title, link, source, ts: Number.isNaN(ts) ? null : ts, summary: desc });
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FPL-Brief/1.0)" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseRss(await res.text(), feed.name);
  } catch (e) {
    console.error(`news.js: feed failed (${feed.name}): ${e.message}`);
    return [];
  }
}

async function gatherItems() {
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
  const seen = new Set();
  const kept = [];
  for (const it of all.sort((a, b) => (b.ts || 0) - (a.ts || 0))) {
    if (it.ts && it.ts < cutoff) continue;
    const key = it.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(it);
    if (kept.length >= MAX_ITEMS) break;
  }
  return kept;
}

// --- AI: filter/rank by FPL relevance via a forced tool call ----------------
const NEWS_TOOL = {
  name: "emit_news_digest",
  description:
    "Emit a pre-season FPL news digest built ONLY from the supplied headlines. " +
    "Select the items that actually change an FPL manager's decisions and explain why. " +
    "Ignore items with no FPL relevance. Never invent news that isn't in the input.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Email subject line" },
      intro: { type: "string", description: "1-2 sentence bottom-line for the week" },
      checklist: { type: "string", description: "Short 'what to watch' line for the footer" },
      sections: {
        type: "array",
        description: "Ordered sections. Use 'news' for story cards, 'prose' for a short outlook.",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["news", "prose"] },
            heading: { type: "string" },
            subheading: { type: "string" },
            items: {
              type: "array",
              description: "News cards (for type 'news')",
              items: {
                type: "object",
                properties: {
                  category: {
                    type: "string",
                    enum: ["TRANSFER", "INJURY", "RETURN", "MANAGER", "FRIENDLY", "SET PIECES", "SUSPENSION", "NEWS"],
                  },
                  headline: { type: "string", description: "Tight rewrite of the story" },
                  why: { type: "string", description: "One line: what it means for your FPL team/picks" },
                  source: { type: "string" },
                  url: { type: "string" },
                },
                required: ["category", "headline", "why"],
              },
            },
            paragraphs: { type: "array", items: { type: "string" } },
            bullets: { type: "array", items: { type: "string" } },
          },
          required: ["type"],
        },
      },
    },
    required: ["subject", "intro", "sections"],
  },
};

const SYSTEM = `You are the editor of "FPL Brief", a sharp weekly Fantasy Premier League email.
It is PRE-SEASON: no gameweeks have been played yet, so this issue is a NEWS digest that helps the reader shape their initial squad and watchlist before Gameweek 1.

From the supplied real headlines, keep ONLY what changes an FPL decision and group them into news cards:
- Confirmed/likely TRANSFERs (who joins/leaves, and the FPL knock-on: minutes, price bracket, set-piece/penalty duties).
- Managerial changes and what they imply for style, nailed starters, clean-sheet potential.
- INJURY / RETURN / SUSPENSION news affecting availability for the season opener.
- Pre-season FRIENDLY performances that hint at form, minutes, or a new role.
- SET PIECES / penalty ownership changes — high FPL value.

Rules:
- Use only the supplied items. Do NOT invent, and do NOT state a transfer as done unless the headline does.
- Every card needs a concrete FPL "why" — no filler. Rank the most decision-relevant first.
- Be concise and punchy. Aim for 6-10 of the best cards, optionally a short 'Pre-season outlook' prose section.
- Carry the source name and the item link through into each card.
Call emit_news_digest exactly once. No prose outside the tool call.`;

async function composeNews(items) {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const user = `Here are this week's real football headlines (JSON). Build the FPL news digest.

\`\`\`json
${JSON.stringify(items.map((i) => ({ title: i.title, source: i.source, url: i.link, summary: i.summary })))}
\`\`\``;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 5000,
      thinking: { type: "disabled" },
      system: SYSTEM,
      tools: [NEWS_TOOL],
      tool_choice: { type: "tool", name: "emit_news_digest" },
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const toolBlock = (data.content || []).find((b) => b.type === "tool_use");
  if (!toolBlock?.input) throw new Error(`no tool_use in response (stop_reason=${data.stop_reason})`);
  const content = toolBlock.input;
  if (!Array.isArray(content.sections) || content.sections.length === 0) throw new Error("no sections");
  return content;
}

// --- deterministic fallback (no AI): keyword-bucketed digest ----------------
function buildFallbackNews(items, meta) {
  const rules = [
    { cat: "TRANSFER", re: /transfer|sign|signing|joins|deal|bid|fee|loan|move|swap/i },
    { cat: "MANAGER", re: /manager|head coach|sacked|appoint|boss|dismiss/i },
    { cat: "INJURY", re: /injur|out for|sidelined|surgery|strain|knock|fitness/i },
    { cat: "RETURN", re: /return|back in training|comeback|fit again/i },
    { cat: "FRIENDLY", re: /friendly|pre-?season|tour|warm-up/i },
  ];
  const picked = [];
  for (const it of items) {
    const hit = rules.find((r) => r.re.test(it.title));
    if (!hit) continue;
    picked.push({
      category: hit.cat,
      headline: it.title,
      why: "Pre-season development to weigh for your GW1 squad.",
      source: it.source,
      url: it.link,
    });
    if (picked.length >= 10) break;
  }
  return {
    subject: `FPL Brief — pre-season news (${meta.season || ""})`.trim(),
    intro: "Automated pre-season digest — the transfer, manager and fitness stories most likely to shape your opening squad.",
    checklist: "watch confirmed starters and set-piece takers before the GW1 deadline.",
    sections: [
      {
        type: "news",
        heading: "This week in the Premier League",
        subheading: "Filtered from official & FPL-community feeds",
        items: picked.length
          ? picked
          : [{ category: "NEWS", headline: "Quiet week on the wires", why: "No major FPL-relevant stories in the latest feeds — check back next week.", source: "FPL Brief" }],
      },
    ],
  };
}

// --- main -------------------------------------------------------------------
export async function runNewsDigest() {
  let digest = {};
  try {
    digest = JSON.parse(await readFile("digest.json", "utf8"));
  } catch {
    /* meta is optional for the news issue */
  }
  const meta = digest.meta || {};

  const items = await gatherItems();
  console.log(`news.js: gathered ${items.length} recent items from ${FEEDS.length} feeds.`);

  let content;
  let source;
  try {
    content = await composeNews(items);
    source = `AI (${MODEL})`;
  } catch (err) {
    console.error(`news.js: AI compose failed → deterministic fallback.\n  reason: ${err.message}`);
    content = buildFallbackNews(items, meta);
    source = "fallback";
  }

  // News issue has no player cards; give the renderer an empty index + meta.
  const html = renderNewsletter(content, { meta, playerIndex: {} });
  await writeFile("newsletter.html", html);
  console.log(`news.js: newsletter.html written (${html.length} chars) via ${source}, ${content.sections.length} sections.`);
  return { source, items: items.length };
}

// Run standalone: `node news.js`
if (process.argv[1]?.endsWith("news.js")) {
  await runNewsDigest();
}
