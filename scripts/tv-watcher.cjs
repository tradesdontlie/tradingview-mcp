#!/usr/bin/env node
/**
 * TradingView stream watcher
 * Reads ~/tv-stream.jsonl and evaluates alert conditions
 * Run via: node tv-watcher.js --above 740.79 --below 735.75 --symbol SPY
 *
 * Usage:
 *   node tv-watcher.js --above 750 --below 730           # price alerts
 *   node tv-watcher.js --above 750 --notify              # with macOS notification
 *   node tv-watcher.js --tail 10                         # show last 10 ticks
 *   node tv-watcher.js --latest                          # show latest tick only
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const STREAM_FILE = path.join(process.env.HOME, 'tv-stream.jsonl');

const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

function readTicks() {
  if (!fs.existsSync(STREAM_FILE)) return [];
  const lines = fs.readFileSync(STREAM_FILE, 'utf8').trim().split('\n');
  return lines
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter(t => t.close || t.last);
}

function notify(title, message) {
  try {
    execSync(`osascript -e 'display notification "${message}" with title "${title}" sound name "Glass"'`);
  } catch {}
  console.log(`\n🔔 ALERT: ${title} — ${message}\n`);
}

function formatTick(t) {
  return `[${new Date(t.time * 1000).toISOString()}] ${t.symbol || ''} C:${t.close} H:${t.high} L:${t.low} V:${t.volume}`;
}

// --latest: print most recent tick
if (hasFlag('--latest')) {
  const ticks = readTicks();
  const last = ticks[ticks.length - 1];
  if (last) console.log(JSON.stringify(last, null, 2));
  else console.log('No ticks yet — is the stream running?');
  process.exit(0);
}

// --tail N: print last N ticks
if (hasFlag('--tail')) {
  const n = parseInt(getArg('--tail') || '10');
  const ticks = readTicks();
  ticks.slice(-n).forEach(t => console.log(formatTick(t)));
  process.exit(0);
}

// --above / --below: check conditions against latest tick
const above = getArg('--above') ? parseFloat(getArg('--above')) : null;
const below = getArg('--below') ? parseFloat(getArg('--below')) : null;
const withNotify = hasFlag('--notify');

if (above !== null || below !== null) {
  const ticks = readTicks();
  const last = ticks[ticks.length - 1];
  if (!last) {
    console.log(JSON.stringify({ alert: false, reason: 'no_data' }));
    process.exit(0);
  }

  const price = last.close || last.last;
  const result = { price, time: last.time, alert: false, conditions: [] };

  if (above !== null && price >= above) {
    result.alert = true;
    result.conditions.push(`price ${price} >= ${above} (above target)`);
    if (withNotify) notify('Price Alert', `${last.symbol || 'Chart'} hit ${price} — above ${above}`);
  }
  if (below !== null && price <= below) {
    result.alert = true;
    result.conditions.push(`price ${price} <= ${below} (below target)`);
    if (withNotify) notify('Price Alert', `${last.symbol || 'Chart'} hit ${price} — below ${below}`);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.alert ? 1 : 0);
}

// Default: show stats
const ticks = readTicks();
if (ticks.length === 0) {
  console.log('No ticks yet. Is the stream running? Check: pm2 status');
  process.exit(0);
}

const last = ticks[ticks.length - 1];
const first = ticks[0];
console.log(JSON.stringify({
  tick_count: ticks.length,
  first_tick: new Date(first.time * 1000).toISOString(),
  last_tick: new Date(last.time * 1000).toISOString(),
  latest: { close: last.close, high: last.high, low: last.low, volume: last.volume }
}, null, 2));
