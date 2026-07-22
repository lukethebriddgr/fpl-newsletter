// compose.js — turns digest.json into a finished HTML newsletter via the Claude API.
// Reads digest.json + METHODOLOGY.md, asks Claude to compose per the methodology,
// writes newsletter.html. Zero deps (built-in fetch). Needs ANTHROPIC_API_KEY.

import { readFile, writeFile } from "node:fs/promises";

const MODEL = process.env.NEWSLETTER_MODEL || "claude-sonnet-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("compose.js: ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const digestRaw = await readFile("digest.json", "utf8");
const methodology = await readFile("METHODOLOGY.md", "utf8");

const system = `${methodology}

---
OUTPUT CONTRACT (overrides any formatting note above):
- Output ONE complete, self-contained HTML document and NOTHING else.
- Start at <!DOCTYPE html>. No markdown, no code fences, no preamble, no sign-off outside the HTML.
- Inline all CSS. No external assets, scripts, or web fonts. Mobile-friendly and readable in an email client.
- Every statistic MUST come from the provided digest.json. Never invent numbers or fixtures.`;

const userContent = `Here is this week's digest.json. Compose the newsletter now, following METHODOLOGY.md exactly, and return only the HTML document.

\`\`\`json
${digestRaw}
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
    max_tokens: 8000,
    system,
    messages: [{ role: "user", content: userContent }],
  }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`compose.js: Claude API HTTP ${res.status}\n${body}`);
  process.exit(1);
}

const data = await res.json();
let html = (data.content || [])
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("")
  .trim();

// Safety net: strip accidental markdown fences if the model wraps the HTML.
html = html.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "").trim();

if (!/^<!doctype html/i.test(html) && !/^<html/i.test(html)) {
  console.error("compose.js: model did not return an HTML document. First 300 chars:\n" + html.slice(0, 300));
  process.exit(1);
}

await writeFile("newsletter.html", html);
console.log(`compose.js: newsletter.html written (${html.length} chars) using ${MODEL}.`);
