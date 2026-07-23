// compose.js — asks Claude for STRUCTURED newsletter content via a forced tool
// call (tool_use.input is returned pre-parsed, so there is no fragile JSON.parse
// of model text — this fixes the "unescaped quote" failures). render.js then owns
// all HTML. If the API call fails, falls back to a deterministic build so an email
// always goes out. Zero deps (built-in fetch). Needs ANTHROPIC_API_KEY.

import "./load-env.js";
import { readFile, writeFile } from "node:fs/promises";
import { renderNewsletter, buildFallbackContent } from "./render.js";

const MODEL = process.env.NEWSLETTER_MODEL || "claude-sonnet-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;

const digest = JSON.parse(await readFile("digest.json", "utf8"));
const methodology = await readFile("METHODOLOGY.md", "utf8");

// Tool schema describing the newsletter content contract. Non-strict: the model
// fills only the fields relevant to each section's `type`.
const NEWSLETTER_TOOL = {
  name: "emit_newsletter",
  description:
    "Emit the finished FPL newsletter as structured content. Follow METHODOLOGY.md exactly. " +
    "Every player is referenced by the numeric id from digest.playerIndex / the section arrays. " +
    "Only use stats present in digest.json.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Email subject line" },
      intro: { type: "string", description: "1-2 sentence bottom-line / headline" },
      checklist: { type: "string", description: "Short 'before the deadline' line" },
      sections: {
        type: "array",
        description: "Ordered newsletter sections",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["snapshot", "players", "recommendations", "roadmap", "watch", "prose"],
            },
            heading: { type: "string" },
            subheading: { type: "string" },
            summary: { type: "string" },
            stats: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" }, value: { type: "string" } },
              },
            },
            groups: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  players: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "integer" },
                        stat: { type: "string" },
                        note: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "integer" },
                  move: { type: "string" },
                  why: { type: "string" },
                  playerIds: { type: "array", items: { type: "integer" } },
                },
              },
            },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: { when: { type: "string" }, action: { type: "string" } },
              },
            },
            risers: {
              type: "array",
              items: { type: "object", properties: { id: { type: "integer" }, note: { type: "string" } } },
            },
            fallers: {
              type: "array",
              items: { type: "object", properties: { id: { type: "integer" }, note: { type: "string" } } },
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

async function composeContent() {
  if (!API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");

  const system = `${methodology}

---
Call the emit_newsletter tool exactly once with the finished content. Do not write any prose outside the tool call.`;

  const user = `Here is this week's digest.json. Compose the newsletter and emit it via the tool.

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
      max_tokens: 5000,
      thinking: { type: "disabled" }, // structured composition; keep it fast + within budget
      system,
      tools: [NEWSLETTER_TOOL],
      tool_choice: { type: "tool", name: "emit_newsletter" },
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = await res.json();
  const toolBlock = (data.content || []).find((b) => b.type === "tool_use");
  if (!toolBlock || !toolBlock.input) {
    throw new Error(`no tool_use in response (stop_reason=${data.stop_reason})`);
  }
  const content = toolBlock.input; // already a parsed object — no JSON.parse
  if (!Array.isArray(content.sections) || content.sections.length === 0) {
    throw new Error("tool input has no sections");
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
