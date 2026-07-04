/**
 * Parse bot_events.jsonl (the bots' escalation feed) since a timestamp cursor.
 * Used by the orchestrator to (a) react to errors/order failures and (b) detect
 * activity. Both bots append here; each record carries ts, bot, severity, type.
 */
import { readFileSync, existsSync } from 'node:fs';

export function readEvents(path, { sinceMs = 0, minSeverity = 'info' } = {}) {
  if (!existsSync(path)) return [];
  const rank = { info: 0, warn: 1, error: 2 };
  const floor = rank[minSeverity] ?? 0;
  const out = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    const ms = rec.ts ? Date.parse(rec.ts) : 0;
    if (ms < sinceMs) continue;
    if ((rank[rec.severity] ?? 0) < floor) continue;
    out.push(rec);
  }
  return out;
}

/** Summarize events into counts the agent can reason over without reading every line. */
export function summarizeEvents(events) {
  const summary = { total: events.length, byType: {}, bySeverity: {}, highSeverity: [] };
  for (const e of events) {
    summary.byType[e.type] = (summary.byType[e.type] ?? 0) + 1;
    summary.bySeverity[e.severity] = (summary.bySeverity[e.severity] ?? 0) + 1;
    if (e.severity === 'error') summary.highSeverity.push(e);
  }
  return summary;
}
