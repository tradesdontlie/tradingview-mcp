#!/usr/bin/env node
/**
 * Orchestrator — one decision cycle, then exit. Run on a schedule (Task Scheduler)
 * and event-driven (woken when a high-severity line lands in bot_events.jsonl).
 *
 * Control plane only: it reasons over the live ledger, escalation events, and the
 * backtest matrix, then proposes at most one config change per bot — auto-applied
 * within the validated universe, or staged for approval when it loosens the risk
 * gate. The deterministic guardrails in lib/ are authoritative; the model proposes,
 * they enforce. See curriculum/ for the durable rules loaded into the system prompt.
 *
 * Requires: npm install (see package.json) and ANTHROPIC_API_KEY (or `ant auth login`).
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildTools } from './tools/index.mjs';
import { MODEL, THRESHOLDS, UNIVERSE } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load the repo-root .env (gitignored) so ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
// can live alongside the bots' Binance keys — no secret on the command line.
// Same minimal KEY=VALUE loader the bots use; existing env vars win.
for (const envPath of [join(ROOT, '.env'), join(__dirname, '.env')]) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

const paths = {
  config: join(ROOT, 'orchestrator_config.json'),
  ledger: join(ROOT, 'trade_ledger.jsonl'),
  events: join(ROOT, 'bot_events.jsonl'),
  matrix: join(ROOT, 'strategy_matrix_results.csv'),
  backtestSpot: join(ROOT, 'backtest_results.json'),
  backtestFutures: join(ROOT, 'backtest_futures_results.json'),
  decisions: join(__dirname, 'decisions'),
  cursor: join(__dirname, '.cursor.json'),
};

function loadCursor() {
  if (!existsSync(paths.cursor)) return { lastRunMs: 0 };
  try { return JSON.parse(readFileSync(paths.cursor, 'utf8')); } catch { return { lastRunMs: 0 }; }
}
function saveCursor() {
  writeFileSync(paths.cursor, JSON.stringify({ lastRunMs: Date.now() }, null, 2));
}

function curriculum() {
  const dir = join(__dirname, 'curriculum');
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => `## ${f}\n\n${readFileSync(join(dir, f), 'utf8')}`).join('\n\n---\n\n');
}

function buildSystemPrompt() {
  const current = existsSync(paths.config) ? readFileSync(paths.config, 'utf8') : '{}';
  return [
    'You are the orchestrator for a Binance testnet trading bot. You operate at the',
    'control-plane level only — you tune which strategies and filters are active per',
    'bot, never individual trades. The rules below are binding.',
    '',
    '# Curriculum (durable rules)',
    curriculum(),
    '',
    '# Validated universe',
    '```json',
    JSON.stringify(UNIVERSE, null, 2),
    '```',
    '',
    '# Thresholds',
    '```json',
    JSON.stringify(THRESHOLDS, null, 2),
    '```',
    '',
    '# Current orchestrator_config.json',
    '```json',
    current,
    '```',
  ].join('\n');
}

const CYCLE_TASK = [
  'Run one orchestration cycle.',
  '',
  'For EACH bot (spot, then futures):',
  '1. Pull the live ledger, recent events, and matrix stats for the active and',
  '   candidate combos.',
  '2. Decide whether changing ONE strategy or ONE filter would better meet the',
  '   objective (win% ≥ 60% AND expectancy ≥ +0.2R AND sample ≥ 20). Use',
  '   evaluate_candidate to dry-run any idea — iterate until a candidate returns',
  '   classification "auto" or "approval", or conclude no change clears the bar.',
  '3. Call commit_decision EXACTLY ONCE for the bot. If nothing beats the current',
  '   config on adequate data, commit the current config unchanged (a no-op',
  '   re-affirmation) — do NOT force a change. Conservatism is correct here.',
  '',
  'Insufficient data is a valid, expected outcome: keep the current config and say so.',
  'Finish with a 3-5 line summary of what you changed (or held) and why.',
].join('\n');

async function main() {
  const cursor = loadCursor();
  const windowMs = Date.now() - THRESHOLDS.EVAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const tools = buildTools({ paths, sinceMs: windowMs });

  const client = new Anthropic();   // ANTHROPIC_API_KEY or `ant auth login`
  const finalMessage = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    system: buildSystemPrompt(),
    tools,
    messages: [{ role: 'user', content: CYCLE_TASK }],
  });

  for (const block of finalMessage.content ?? []) {
    if (block.type === 'text') console.log(block.text);
  }
  saveCursor();
  void cursor; // reserved: event-driven cycles can use cursor.lastRunMs for the events window
}

main().catch((err) => { console.error('orchestrator cycle failed:', err); process.exit(1); });
