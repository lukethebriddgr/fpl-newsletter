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
const digest = JSON.parse(await readFile("digest.json", "utf8"));
const gw = digest?.meta?.lastFinishedGw ?? "?";
const date = new Date().toISOString().slice(0, 10);
const subject = `FPL Newsletter - GW${gw} - ${date}`;

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
