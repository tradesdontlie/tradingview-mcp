import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './permissions.js';

export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const OUTPUT_KEYS = Object.freeze({ screenshots: 'MCP_SCREENSHOT_DIR' });
const defaults = { screenshots: 'screenshots' };

export function validateOutputDirectory(value) {
  if (typeof value !== 'string') throw new Error('Output directory must be text');
  if (/[\x00-\x1f\x7f"]/u.test(value) || value.length > 32760) {
    throw new Error('Output directory contains a control character, double quote, or is too long');
  }
  const normalized = value.trim();
  if (/^[A-Za-z]:(?![\\/])/.test(normalized)) throw new Error('Use a full drive path such as C:\\Exports, not a drive-relative path');
  return normalized;
}

export function resolveOutputDirectory(kind, value, { checkExisting = false } = {}) {
  if (!Object.hasOwn(defaults, kind)) throw new Error('Unknown output directory kind');
  const configured = validateOutputDirectory(value);
  const path = resolve(PROJECT_ROOT, configured || defaults[kind]);
  if (checkExisting && !/^(?:\\\\|\/\/)/.test(path) && existsSync(path) && !statSync(path).isDirectory()) throw new Error(`Output destination is a file: ${path}`);
  return path;
}

export function loadOutputPaths({ file = loadEnv(), environment = process.env } = {}) {
  const result = {};
  for (const [kind, key] of Object.entries(OUTPUT_KEYS)) {
    result[kind] = { configured: file[key] ?? '', override: Object.hasOwn(environment, key) ? environment[key] : undefined };
  }
  return result;
}

// Read at each export, rather than caching settings when the server starts.
export function getOutputDirectory(kind) {
  const settings = loadOutputPaths()[kind];
  if (!settings) throw new Error('Unknown output directory kind');
  return resolveOutputDirectory(kind, settings.override ?? settings.configured, { checkExisting: true });
}

export function outputPathsToEnv(values) {
  const env = {};
  for (const [kind, key] of Object.entries(OUTPUT_KEYS)) {
    const value = validateOutputDirectory(values[kind]);
    resolveOutputDirectory(kind, value, { checkExisting: true });
    // Our existing .env parser strips the outer quotes without unescaping:
    // literal Windows/UNC backslashes, apostrophes, spaces and # survive intact.
    env[key] = value ? `"${value}"` : '';
  }
  return env;
}

// Keep generated files ordinary portable files, including SOURCE:TICKER batches.
// In particular ':' must never create a Windows NTFS alternate data stream.
export function sanitizeOutputBasename(value) {
  if (typeof value !== 'string') throw new Error('Output filename must be text');
  let name = value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/\.\./g, '_').replace(/[. ]+$/g, '');
  if (!name) name = 'export';
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
