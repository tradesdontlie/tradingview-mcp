// Minimal zero-dependency .env.local loader (T132).
// Loads KEY=VALUE lines from the repo-root .env.local into process.env so the
// headless backtest sidecars can read secrets like TV_SESSION / TV_SIGNATURE
// without them being exported into the launching environment by hand.
// The file is gitignored (.gitignore: .env.*) — never commit the session token.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Parse KEY=VALUE lines into a plain object. Skips blanks and `#` comments;
// keeps any `=` inside the value (e.g. base64 padding). Pure — no I/O.
export function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (key) out[key] = t.slice(eq + 1).trim();
  }
  return out;
}

// Load pairs from `path` into `env`, WITHOUT overriding keys already set
// (the real environment wins). No-op + {} if the file is absent. Returns the
// parsed pairs for inspection/testing.
export function loadEnvFile(path, env = process.env) {
  if (!existsSync(path)) return {};
  const parsed = parseEnv(readFileSync(path, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) env[k] = v;
  }
  return parsed;
}

// Side-effect on import: load the repo-root .env.local into process.env.
const defaultPath = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env.local');
loadEnvFile(defaultPath);
