// Signal engine — periodically evaluates registered rules against the
// ring buffers of their subscriptions and emits matches to a hybrid sink:
//   - append to ~/.tradingview-mcp/signals.jsonl (audit)
//   - track in-memory "active signals" list (poll surface)
//
// MCP resource publishing for live push is left to a follow-up commit
// (server-push needs MCP 2025-06 resource subscription support in the SDK).

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evaluateRule, validateRule } from './dsl.js';
import { getRing } from '../streaming/manager.js';

const DIR = path.join(os.homedir(), '.tradingview-mcp');
const SIGNAL_LOG = path.join(DIR, 'signals.jsonl');

const rules = new Map();           // name -> rule
const lastFired = new Map();       // name -> ts
const activeSignals = [];          // last-N unacknowledged signals
const MAX_ACTIVE = 200;

let timer = null;
const EVAL_INTERVAL_MS = 2_000;

function ensureDir() {
  try { mkdirSync(DIR, { recursive: true }); } catch {}
}

function persist(entry) {
  ensureDir();
  try {
    appendFileSync(SIGNAL_LOG, JSON.stringify(entry) + '\n');
  } catch { /* skip persistence failure */ }
}

function tick() {
  for (const [name, rule] of rules.entries()) {
    const ring = getRing(rule.sub_id);
    if (!ring) continue;
    const { matched, details } = evaluateRule(rule, ring);
    if (!matched) continue;
    const cooldown = rule.cooldown_ms || 0;
    const last = lastFired.get(name) || 0;
    if (cooldown > 0 && Date.now() - last < cooldown) continue;
    lastFired.set(name, Date.now());
    const entry = {
      name,
      sub_id: rule.sub_id,
      timestamp: new Date().toISOString(),
      details,
      acknowledged: false,
    };
    persist(entry);
    activeSignals.unshift(entry);
    if (activeSignals.length > MAX_ACTIVE) activeSignals.length = MAX_ACTIVE;
  }
}

export function startEngine() {
  if (timer) return;
  timer = setInterval(tick, EVAL_INTERVAL_MS);
}
export function stopEngine() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function registerRule(rule) {
  const errors = validateRule(rule);
  if (errors.length) return { ok: false, errors };
  rules.set(rule.name, rule);
  startEngine();
  return { ok: true, name: rule.name };
}

export function removeRule(name) {
  return { removed: rules.delete(name) };
}

export function listRules() {
  return Array.from(rules.values());
}

export function active({ limit = 50 } = {}) {
  return { count: activeSignals.length, signals: activeSignals.slice(0, limit) };
}

export function ack(idx) {
  if (typeof idx !== 'number' || idx < 0 || idx >= activeSignals.length) {
    return { ok: false, error: 'bad index' };
  }
  const removed = activeSignals.splice(idx, 1)[0];
  return { ok: true, removed };
}
