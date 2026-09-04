// JSONL tool-call log — one line per MCP tool call, so you can grep or replay
// what the agent did to the chart. Disabled unless TV_MCP_LOG_FILE is set.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';

const RAW_PATH = (process.env.TV_MCP_LOG_FILE || '').trim();
const LOG_PATH = RAW_PATH
  ? resolve(RAW_PATH.startsWith('~') ? RAW_PATH.replace(/^~/, homedir()) : RAW_PATH)
  : null;

// Results can be enormous (screenshots are base64). Keep the log greppable.
const MAX_RESULT_CHARS = 2000;

export const enabled = LOG_PATH !== null;

function summarize(result) {
  if (result == null) return null;
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((p) => (p?.type === 'text' ? p.text : `[${p?.type || 'unknown'}]`))
    .join('\n');
  return {
    is_error: result.isError === true,
    chars: text.length,
    text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…[truncated]` : text,
  };
}

export function logCall(tool, args, result, durationMs, error) {
  if (!LOG_PATH) return;
  const entry = {
    ts: new Date().toISOString(),
    tool,
    args: args ?? {},
    duration_ms: Math.round(durationMs * 100) / 100,
  };
  if (error) entry.threw = String(error?.message || error);
  else entry.result = summarize(result);

  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Logging must never break a tool call.
  }
}

// Wrap server.tool() so every registered tool is logged without touching the
// individual register*() modules.
export function instrument(server) {
  if (!LOG_PATH) return server;
  const original = server.tool.bind(server);
  server.tool = (...args) => {
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];
    if (typeof handler !== 'function') return original(...args);
    const name = typeof args[0] === 'string' ? args[0] : 'unknown';

    args[handlerIndex] = async (...handlerArgs) => {
      const started = performance.now();
      try {
        const result = await handler(...handlerArgs);
        logCall(name, handlerArgs[0], result, performance.now() - started);
        return result;
      } catch (err) {
        logCall(name, handlerArgs[0], null, performance.now() - started, err);
        throw err;
      }
    };
    return original(...args);
  };
  return server;
}
