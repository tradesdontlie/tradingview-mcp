/**
 * HTTP client for the MT5 bridge (scripts/mt5_bridge.py).
 * The bridge runs on the same machine as the MT5 terminal and speaks
 * plain JSON over HTTP — this is a thin fetch wrapper, mirroring the
 * conventions in src/connection.js (env-overridable host/port, no retries
 * baked in beyond a single timeout since order placement must not be
 * silently retried).
 */
export const MT5_HOST = process.env.MT5_BRIDGE_HOST || '127.0.0.1';
export const MT5_PORT = Number(process.env.MT5_BRIDGE_PORT) || 8721;
const TIMEOUT_MS = 10_000;

async function request(method, path, body) {
  const url = `http://${MT5_HOST}:${MT5_PORT}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`MT5 bridge timed out after ${TIMEOUT_MS}ms at ${url}`);
    }
    throw new Error(`MT5 bridge unreachable at ${url}: ${err.message}. Is scripts/mt5_bridge.py running?`);
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`MT5 bridge returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `MT5 bridge error (HTTP ${res.status})`);
  }
  return json;
}

export const mt5Get = (path) => request('GET', path);
export const mt5Post = (path, body) => request('POST', path, body);
