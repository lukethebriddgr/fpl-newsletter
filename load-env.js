// load-env.js — loads secrets from a local .env into process.env, if present.
// Secrets live ONLY in .env (gitignored). If .env is absent (e.g. a CI runner that
// injects env vars another way), this is a no-op and existing process.env is used.
import { existsSync } from "node:fs";

if (existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}
