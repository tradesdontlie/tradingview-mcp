// India broker secrets loader. Reads from ~/.tradingview-mcp/.env.india if
// present, else process.env. Never logs values.

import { config as dotenvConfig } from 'dotenv';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_DIR = path.join(os.homedir(), '.tradingview-mcp');
const DEFAULT_FILE = path.join(DEFAULT_DIR, '.env.india');

let _loaded = false;
function ensureLoaded() {
  if (_loaded) return;
  if (existsSync(DEFAULT_FILE)) dotenvConfig({ path: DEFAULT_FILE });
  _loaded = true;
}

export function configDir() {
  if (!existsSync(DEFAULT_DIR)) mkdirSync(DEFAULT_DIR, { recursive: true });
  return DEFAULT_DIR;
}

export function get(name) {
  ensureLoaded();
  return process.env[name] || null;
}

export function requireKeys(names) {
  ensureLoaded();
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) {
    const err = new Error(
      `Missing required env: ${missing.join(', ')}. Set them in ${DEFAULT_FILE} or process env.`
    );
    err.missing = missing;
    throw err;
  }
  return Object.fromEntries(names.map(n => [n, process.env[n]]));
}

export function safeStatus() {
  ensureLoaded();
  return {
    config_file: DEFAULT_FILE,
    config_file_exists: existsSync(DEFAULT_FILE),
    keys_present: {
      upstox: Boolean(process.env.UPSTOX_ACCESS_TOKEN),
      delta_india: Boolean(process.env.DELTA_INDIA_API_KEY && process.env.DELTA_INDIA_API_SECRET),
      coindcx: Boolean(process.env.COINDCX_API_KEY && process.env.COINDCX_API_SECRET),
    },
  };
}
