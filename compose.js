// compose.js — asks Claude for STRUCTURED newsletter content (JSON matching the
// contract in METHODOLOGY.md), then hands it to render.js which owns all HTML.
// If the API call or JSON parse fails, falls back to a deterministic build so an
// email always goes out. Zero deps (built-in fetch). Needs ANTHROPIC_API_KEY.

import "./load-env.js";
import { readFile, writeFile } from "node:fs/promises";
import { renderNewsletter, buildFallbackContent } from "./render.js";

const MODEL = process.env.NEWSLETTER_MODEL || "claude-sonnet-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;

const digest = JSON.parse(await readFile("digest.json", "utf8"));
const methodology = await readFile("METHODOLOGY.md", "utf8");

async function composeContent() {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const system = `${methodology}

---
OUTPUT CONTRACT (overrides any other formatting note):
- Return ONE JSON object ONLY — matching the content schema in this document.
- No markdown, no code fences, no commentary before or after. Start with { and end with }.
- Every player reference is the numeric "id" from digest.playerIndex / the section arrays.
- Never invent stats; use only values present in digest.json. Omit any section that has no data.`;

  const user = `Here is this week's digest.json. Produce the newsletter content JSON now.

\`\`\`json
${JSON.stringify(digest)}
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
      max_tokens: 4500,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  let txt = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  txt = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = txt.indexOf("{");
  const last = txt.lastIndexOf("}");
  if (first >= 0 && last > first) txt = txt.slice(first, last + 1);

  const content = JSON.parse(txt);
  if (!content || !Array.isArray(content.sections) || content.sections.length === 0) {
    throw new Error("parsed content has no sections");
  }
  return content;
}

let content;
let source;
try {
  content = await composeContent();
  source = `AI (${MODEL})`;
} catch (err) {
  console.error(`compose.js: AI compose failed → deterministic fallback.\n  reason: ${err.message}`);
  content = buildFallbackContent(digest);
  source = "fallback";
}

const html = renderNewsletter(content, digest);
await writeFile("newsletter.html", html);
console.log(`compose.js: newsletter.html written (${html.length} chars) via ${source}, ${content.sections.length} sections.`);
