// render.js — deterministic, email-safe HTML renderer for the FPL newsletter.
// The AI (compose.js) returns a structured `content` object; this file owns ALL
// layout, styling, images and the footer, so formatting is identical every week.
//
// Also exports buildFallbackContent(digest) — a no-AI content builder used both
// for local design testing (CLI) and as compose.js's fallback if the API fails.
//
// Design: Premier League brand language (deep purple #37003c, PL pink/green),
// card sections, player photos + team badges from the PL media CDN. Table-based,
// inline-styled, <=600px, no JS — so it survives Gmail/Outlook/Apple Mail.

import { readFile, writeFile } from "node:fs/promises";

// --- palette / tokens -------------------------------------------------------
const C = {
  purple: "#37003c",
  purpleDeep: "#2b0030",
  pink: "#e90052",
  green: "#00ff87",
  cyan: "#04f5ff",
  ink: "#1f1147",
  body: "#33333d",
  muted: "#7a7a88",
  line: "#e7e3ec",
  card: "#ffffff",
  page: "#eae6ef",
  chip: "#f3f0f7",
};
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// --- helpers ----------------------------------------------------------------
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const photoUrl = (code) =>
  code
    ? `https://resources.premierleague.com/premierleague/photos/players/110x140/p${code}.png`
    : null;
const badgeUrl = (teamCode) =>
  teamCode
    ? `https://resources.premierleague.com/premierleague/badges/t${teamCode}.png`
    : null;

function pill(text, { bg = C.chip, fg = C.ink, bold = true } = {}) {
  return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${bg};color:${fg};font:${bold ? "700" : "600"} 11px/1.4 ${FONT};letter-spacing:.02em;white-space:nowrap;">${esc(text)}</span>`;
}

// A player row: circular photo + name + badge + stat pill + note.
function playerRow(p, note, statText) {
  const photo = photoUrl(p?.code);
  const badge = badgeUrl(p?.teamCode);
  const avatar = photo
    ? `<img src="${photo}" width="46" height="46" alt="${esc(p?.name || "")}" style="display:block;width:46px;height:46px;border-radius:50%;background:${C.chip};object-fit:cover;border:2px solid ${C.line};" />`
    : `<div style="width:46px;height:46px;border-radius:50%;background:${C.purple};color:#fff;font:800 16px/46px ${FONT};text-align:center;">${esc((p?.name || "?").slice(0, 1))}</div>`;
  const badgeImg = badge
    ? `<img src="${badge}" width="16" height="16" alt="${esc(p?.teamShort || "")}" style="vertical-align:middle;width:16px;height:16px;margin-right:5px;" />`
    : "";
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 10px;">
    <tr>
      <td width="54" valign="top" style="padding:0;">${avatar}</td>
      <td valign="top" style="padding:0 0 0 6px;">
        <div style="font:800 15px/1.25 ${FONT};color:${C.ink};">${esc(p?.name || "Unknown")}</div>
        <div style="font:600 12px/1.4 ${FONT};color:${C.muted};margin:2px 0 5px;">${badgeImg}${esc(p?.teamShort || "")}${p?.position ? " · " + esc(p.position) : ""}${p?.price ? " · £" + esc(p.price) + "m" : ""}</div>
        ${statText ? `<div style="margin:0 0 4px;">${pill(statText, { bg: C.purple, fg: "#fff" })}</div>` : ""}
        ${note ? `<div style="font:500 13px/1.5 ${FONT};color:${C.body};">${esc(note)}</div>` : ""}
      </td>
    </tr>
  </table>`;
}

function sectionShell(heading, subheading, innerHtml, accent = C.pink) {
  return `
  <tr><td style="padding:22px 24px 0;">
    <div style="border-left:4px solid ${accent};padding:0 0 0 12px;margin:0 0 14px;">
      <div style="font:800 18px/1.2 ${FONT};color:${C.ink};letter-spacing:-.01em;">${esc(heading)}</div>
      ${subheading ? `<div style="font:600 13px/1.4 ${FONT};color:${C.muted};margin-top:3px;">${esc(subheading)}</div>` : ""}
    </div>
    ${innerHtml}
  </td></tr>
  <tr><td style="padding:18px 24px 0;"><div style="height:1px;background:${C.line};line-height:1px;">&nbsp;</div></td></tr>`;
}

// --- per-type section renderers --------------------------------------------
function renderSnapshot(s, idx) {
  const stats = (s.stats || [])
    .map(
      (st) => `
      <td style="padding:0 6px 0 0;" valign="top">
        <div style="background:${C.chip};border-radius:10px;padding:10px 12px;text-align:center;">
          <div style="font:800 19px/1.1 ${FONT};color:${C.purple};">${esc(st.value)}</div>
          <div style="font:600 11px/1.3 ${FONT};color:${C.muted};text-transform:uppercase;letter-spacing:.04em;margin-top:3px;">${esc(st.label)}</div>
        </div>
      </td>`
    )
    .join("");
  const inner = `
    ${s.summary ? `<div style="font:500 14px/1.6 ${FONT};color:${C.body};margin:0 0 14px;">${esc(s.summary)}</div>` : ""}
    ${stats ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;table-layout:fixed;"><tr>${stats}</tr></table>` : ""}`;
  return sectionShell(s.heading || "Your team", s.subheading, inner, C.cyan);
}

function renderPlayers(s, idx) {
  const groups = (s.groups || [])
    .map((g) => {
      const rows = (g.players || [])
        .map((pl) => playerRow(idx[pl.id] || { name: pl.name }, pl.note, pl.stat))
        .join("");
      const label = g.label
        ? `<div style="font:800 12px/1.2 ${FONT};color:${C.pink};text-transform:uppercase;letter-spacing:.06em;margin:6px 0 10px;">${esc(g.label)}</div>`
        : "";
      return label + rows;
    })
    .join("");
  return sectionShell(s.heading || "Players", s.subheading, groups, C.pink);
}

function renderRecommendations(s, idx) {
  const items = (s.items || [])
    .map((it) => {
      const chips = (it.playerIds || [])
        .map((id) => idx[id])
        .filter(Boolean)
        .map((p) => {
          const badge = badgeUrl(p.teamCode);
          return `<span style="display:inline-block;margin:4px 6px 0 0;padding:4px 10px;background:${C.chip};border-radius:999px;font:700 12px/1.3 ${FONT};color:${C.ink};">${badge ? `<img src="${badge}" width="14" height="14" style="vertical-align:middle;margin-right:4px;" alt="" />` : ""}${esc(p.name)}</span>`;
        })
        .join("");
      return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 12px;">
        <tr>
          <td width="34" valign="top" style="padding:0;">
            <div style="width:26px;height:26px;border-radius:50%;background:${C.purple};color:#fff;font:800 14px/26px ${FONT};text-align:center;">${esc(it.rank ?? "")}</div>
          </td>
          <td valign="top" style="padding:0 0 0 4px;">
            <div style="font:800 15px/1.35 ${FONT};color:${C.ink};">${esc(it.move || it.title || "")}</div>
            ${it.why ? `<div style="font:500 13px/1.55 ${FONT};color:${C.body};margin-top:3px;">${esc(it.why)}</div>` : ""}
            ${chips ? `<div style="margin-top:6px;">${chips}</div>` : ""}
          </td>
        </tr>
      </table>`;
    })
    .join("");
  return sectionShell(s.heading || "Your top moves", s.subheading, items, C.green);
}

function renderRoadmap(s) {
  const steps = (s.steps || [])
    .map(
      (st) => `
      <tr>
        <td width="70" valign="top" style="padding:0 10px 12px 0;">
          <div style="background:${C.purple};color:#fff;border-radius:8px;padding:6px 4px;text-align:center;font:800 12px/1.2 ${FONT};">${esc(st.when || "")}</div>
        </td>
        <td valign="top" style="padding:0 0 12px;font:500 13px/1.55 ${FONT};color:${C.body};border-bottom:1px solid ${C.line};">${esc(st.action || "")}</td>
      </tr>`
    )
    .join("");
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${steps}</table>`;
  return sectionShell(s.heading || "Roadmap", s.subheading, inner, C.cyan);
}

function renderWatch(s, idx) {
  const col = (title, arr, color, sign) => {
    const rows = (arr || [])
      .map((w) => {
        const p = idx[w.id] || { name: w.name };
        const badge = badgeUrl(p.teamCode);
        return `<div style="font:600 13px/1.5 ${FONT};color:${C.body};margin:0 0 6px;">${badge ? `<img src="${badge}" width="14" height="14" style="vertical-align:middle;margin-right:5px;" alt="" />` : ""}<b style="color:${C.ink};">${esc(p.name)}</b>${w.note ? ` — ${esc(w.note)}` : ""}</div>`;
      })
      .join("");
    return `
      <td width="50%" valign="top" style="padding:0 8px;">
        <div style="font:800 12px/1.2 ${FONT};color:${color};text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px;">${sign} ${esc(title)}</div>
        ${rows || `<div style="font:500 13px/1.5 ${FONT};color:${C.muted};">Nothing notable.</div>`}
      </td>`;
  };
  const inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>${col("Rising", s.risers, C.pink, "▲")}${col("Falling", s.fallers, "#0b7", "▼")}</tr></table>`;
  return sectionShell(s.heading || "Price watch", s.subheading, inner, C.pink);
}

function renderProse(s) {
  const paras = (s.paragraphs || [])
    .map((p) => `<div style="font:500 14px/1.65 ${FONT};color:${C.body};margin:0 0 10px;">${esc(p)}</div>`)
    .join("");
  const bullets = (s.bullets || []).length
    ? `<ul style="margin:6px 0 0;padding:0 0 0 18px;">${s.bullets.map((b) => `<li style="font:500 14px/1.6 ${FONT};color:${C.body};margin:0 0 6px;">${esc(b)}</li>`).join("")}</ul>`
    : "";
  return sectionShell(s.heading || "", s.subheading, paras + bullets, C.purple);
}

const RENDERERS = {
  snapshot: renderSnapshot,
  players: renderPlayers,
  recommendations: renderRecommendations,
  roadmap: renderRoadmap,
  watch: renderWatch,
  prose: renderProse,
};

// --- top-level document -----------------------------------------------------
export function renderNewsletter(content, digest) {
  const idx = digest?.playerIndex || {};
  const meta = digest?.meta || {};
  const gwLabel =
    meta.seasonState === "in_season" && meta.nextGw
      ? `Gameweek ${meta.nextGw} preview`
      : meta.lastFinishedGw
      ? `After GW${meta.lastFinishedGw}`
      : "Pre-season";
  const date = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  const sectionsHtml = (content.sections || [])
    .map((s) => (RENDERERS[s.type] ? RENDERERS[s.type](s, idx) : renderProse(s)))
    .join("");

  const staleNote =
    meta.generatedAt && Date.now() - new Date(meta.generatedAt).getTime() > 8 * 864e5
      ? `<tr><td style="padding:0 24px;"><div style="background:#fff6e5;border:1px solid #ffd98a;border-radius:8px;padding:10px 12px;font:600 12px/1.5 ${FONT};color:#7a5b00;">Heads-up: the underlying data is more than a week old — the weekly refresh may have failed.</div></td></tr>`
      : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="color-scheme" content="light" /><title>${esc(content.subject || "FPL Brief")}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(content.intro || "Your weekly FPL brief.")}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};border-collapse:collapse;">
    <tr><td align="center" style="padding:20px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;border-collapse:collapse;background:${C.card};border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(31,17,71,.08);">

        <!-- masthead -->
        <tr><td style="background:${C.purple};background-image:linear-gradient(135deg,${C.purpleDeep},${C.purple});padding:26px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td valign="middle">
              <div style="font:800 22px/1 ${FONT};color:#fff;letter-spacing:.14em;">FPL&nbsp;BRIEF</div>
              <div style="font:600 12px/1.4 ${FONT};color:${C.green};margin-top:6px;letter-spacing:.03em;">${esc(gwLabel)} · ${esc(date)}</div>
            </td>
            <td valign="middle" align="right">
              <span style="display:inline-block;padding:6px 12px;border:1px solid rgba(255,255,255,.3);border-radius:999px;font:700 11px/1 ${FONT};color:#fff;">${esc(meta.season || "")}</span>
            </td>
          </tr></table>
        </td></tr>

        <!-- TL;DR -->
        ${content.intro ? `<tr><td style="padding:20px 24px 0;"><div style="background:${C.ink};border-radius:12px;padding:16px 18px;"><div style="font:800 11px/1 ${FONT};color:${C.green};letter-spacing:.1em;margin-bottom:8px;">THE BOTTOM LINE</div><div style="font:600 15px/1.55 ${FONT};color:#fff;">${esc(content.intro)}</div></div></td></tr>` : ""}
        ${staleNote}

        <!-- sections -->
        ${sectionsHtml}

        <!-- footer -->
        <tr><td style="background:${C.purple};padding:22px 24px;">
          <div style="font:700 13px/1.4 ${FONT};color:#fff;">FPL Brief</div>
          <div style="font:500 12px/1.6 ${FONT};color:rgba(255,255,255,.6);margin-top:6px;">Automated weekly from the official Premier League data. Numbers are decision aids, not certainties — always check team news before the deadline.</div>
          ${content.checklist ? `<div style="font:600 12px/1.6 ${FONT};color:${C.green};margin-top:10px;">Before the deadline: ${esc(content.checklist)}</div>` : ""}
        </td></tr>

      </table>
      <div style="font:500 11px/1.5 ${FONT};color:${C.muted};margin-top:14px;">Generated ${esc(date)} · data: Official FPL API</div>
    </td></tr>
  </table>
</body></html>`;
}

// --- deterministic fallback content (no AI) ---------------------------------
// Used for local testing and as compose.js's safety net. Plainer prose, but a
// fully valid, on-brand newsletter built straight from digest.json.
export function buildFallbackContent(digest) {
  const m = digest.meta || {};
  const sections = [];

  if (digest.manager && !digest.manager.error) {
    const mg = digest.manager;
    sections.push({
      type: "snapshot",
      heading: `${mg.teamName || "Your team"}`,
      subheading: `Overall rank ${fmt(mg.overallRank)} · ${fmt(mg.totalPoints)} pts`,
      summary: `Squad value £${mg.squadValue}m, £${mg.bank}m in the bank, ~${mg.freeTransfersEstimate} free transfer(s) (estimated).`,
      stats: [
        { label: "Total", value: fmt(mg.totalPoints) },
        { label: "Rank", value: shortNum(mg.overallRank) },
        { label: "Last GW", value: fmt(mg.lastGwPoints) },
        { label: "Bank", value: `£${mg.bank}m` },
      ],
    });
  }

  const bow = digest.bestOfWeek || {};
  if (bow.gw) {
    sections.push({
      type: "players",
      heading: `Best of Gameweek ${bow.gw}`,
      subheading: "Ranked by underlying data, not just points",
      groups: ["DEF", "MID", "FWD"].map((pos) => ({
        label: pos,
        players: (bow[pos] || []).map((p) => ({
          id: p.id,
          stat: `xGI ${p.xgi} · ${p.points} pts`,
          note: `${p.minutes}' · xG ${p.xg}, xA ${p.xa}, ICT ${p.ict}`,
        })),
      })),
    });
  }

  if ((digest.consistentPerformers || []).length) {
    sections.push({
      type: "players",
      heading: "Consistent performers",
      subheading: "High floor, nailed minutes, repeatable threat",
      groups: [
        {
          label: "Week in, week out",
          players: digest.consistentPerformers.slice(0, 8).map((c) => ({
            id: c.id,
            stat: `${c.meanPoints} avg · xGI/90 ${c.xgiPer90}`,
            note: `${c.pointsPerGame} ppg · ${Math.round(c.minutesReliability * 100)}% starts`,
          })),
        },
      ],
    });
  }

  if (digest.priceWatch && (digest.priceWatch.risers.length || digest.priceWatch.fallers.length)) {
    sections.push({
      type: "watch",
      heading: "Price & transfer watch",
      subheading: digest.priceWatch.note,
      risers: digest.priceWatch.risers.slice(0, 5).map((r) => ({ id: r.id, note: `net ${shortNum(r.netTransfers)}` })),
      fallers: digest.priceWatch.fallers.slice(0, 5).map((r) => ({ id: r.id, note: `net ${shortNum(r.netTransfers)}` })),
    });
  }

  if (digest.manager?.upgradeSuggestions?.length) {
    sections.push({
      type: "recommendations",
      heading: "Suggested moves",
      subheading: "Script-ranked by projected upside — weigh against banking your transfer",
      items: digest.manager.upgradeSuggestions.slice(0, 3).map((s, i) => ({
        rank: i + 1,
        move: `${s.out.name} → ${s.in[0].name}`,
        why: `Projected +${s.projectionDelta} over the horizon. ${s.out.name} £${s.out.price}m out, ${s.in[0].name} £${s.in[0].price}m in.`,
        playerIds: [s.out.id, s.in[0].id],
      })),
    });
  }

  if (m.note) {
    sections.push({ type: "prose", heading: "Note", paragraphs: [m.note] });
  }

  return {
    subject: `FPL Brief — ${m.lastFinishedGw ? "GW" + m.lastFinishedGw : m.season}`,
    intro:
      digest.manager && !digest.manager.error
        ? `Auto-generated brief for ${digest.manager.teamName}. ${m.seasonState !== "in_season" ? "Season data only — fixtures, chips and price timing resume at kickoff." : ""}`
        : "Your weekly FPL brief.",
    checklist: "check team news, then confirm or bank your transfer.",
    sections,
  };
}

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-GB"));
const shortNum = (n) => {
  if (n == null) return "—";
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(0) + "k";
  return String(n);
};

// --- CLI: render a fallback newsletter from digest.json (design testing) ----
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("render.js")) {
  const digest = JSON.parse(await readFile("digest.json", "utf8"));
  const content = process.argv[2]
    ? JSON.parse(await readFile(process.argv[2], "utf8"))
    : buildFallbackContent(digest);
  const html = renderNewsletter(content, digest);
  await writeFile("newsletter.html", html);
  console.log(`render.js: newsletter.html written (${html.length} chars, ${content.sections.length} sections).`);
}
