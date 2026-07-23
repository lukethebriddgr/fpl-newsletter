// send-email.js — emails newsletter.html via Gmail SMTP (app password).
// Env: GMAIL_ADDRESS, GMAIL_APP_PASSWORD, RECIPIENT (optional; defaults to GMAIL_ADDRESS).

import "./load-env.js";
import { readFile } from "node:fs/promises";
import nodemailer from "nodemailer";

const { GMAIL_ADDRESS, GMAIL_APP_PASSWORD } = process.env;
const RECIPIENT = process.env.RECIPIENT || GMAIL_ADDRESS;

if (!GMAIL_ADDRESS || !GMAIL_APP_PASSWORD) {
  console.error("send-email.js: GMAIL_ADDRESS and GMAIL_APP_PASSWORD must be set.");
  process.exit(1);
}

const html = await readFile("newsletter.html", "utf8");

// Prefer the composed subject (render.js writes content.subject into <title>);
// fall back to a generated one only if the title is missing/default.
const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
const composedSubject = titleMatch
  ? titleMatch[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim()
  : "";
let subject = composedSubject;
if (!subject || subject === "FPL Brief") {
  let gw = "?";
  try {
    const digest = JSON.parse(await readFile("digest.json", "utf8"));
    gw = digest?.meta?.lastFinishedGw ?? "?";
  } catch {}
  subject = `FPL Brief - GW${gw} - ${new Date().toISOString().slice(0, 10)}`;
}

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: { user: GMAIL_ADDRESS, pass: GMAIL_APP_PASSWORD },
});

const info = await transporter.sendMail({
  from: `FPL Newsletter <${GMAIL_ADDRESS}>`,
  to: RECIPIENT,
  subject,
  html,
});

console.log(`send-email.js: sent "${subject}" to ${RECIPIENT} (messageId ${info.messageId}).`);
