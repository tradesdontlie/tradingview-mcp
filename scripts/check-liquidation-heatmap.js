#!/usr/bin/env node
/**
 * Liquidation & Funding Rate Checker via CoinGlass API
 * Fetches liquidation data, funding rates, open interest, and long/short ratios
 * for each trade setup found by the scanner.
 *
 * Usage:
 *   node scripts/check-liquidation-heatmap.js                  # check all from latest scan
 *   node scripts/check-liquidation-heatmap.js --symbol ETH     # check single symbol
 *   node scripts/check-liquidation-heatmap.js --symbol BTC,ETH # check multiple
 *
 * Env: COINGLASS_API_KEY (or hardcoded below)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

const API_KEY = process.env.COINGLASS_API_KEY || 'aa356c0656384ca78ee3fb45697e1e3d';
const BASE_URL = 'https://open-api.coinglass.com/public/v2';
const OUTPUT_DIR = '/Users/apex/tradingview-mcp/scans';

const { values: args } = parseArgs({
  options: {
    symbol: { type: 'string', default: '' },
  },
  strict: false,
});

function log(msg) { process.stderr.write(`[liq-check] ${msg}\n`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CoinGlass API calls ─────────────────────────────────────────────────────
async function cgFetch(endpoint, params = {}) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      'accept': 'application/json',
      'CG-API-KEY': API_KEY,
      'coinglassSecret': API_KEY,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CoinGlass API ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.code !== '0' && json.code !== 0 && json.success !== true) {
    throw new Error(`CoinGlass API error: ${json.msg || JSON.stringify(json).slice(0, 200)}`);
  }
  return json.data;
}

// Get funding rates for a symbol
async function getFundingRate(symbol) {
  try {
    const data = await cgFetch('/funding', { symbol, time_type: 'h8' });
    if (!data || !data.length) return null;
    // Find Binance or first available
    const binance = data.find(d => d.exchangeName === 'Binance') || data[0];
    return {
      exchange: binance.exchangeName,
      rate: binance.rate,
      next_time: binance.nextFundingTime,
      predicted: binance.predictedRate,
    };
  } catch (e) {
    log(`  Funding rate failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// Get open interest
async function getOpenInterest(symbol) {
  try {
    const data = await cgFetch('/open_interest', { symbol, time_type: 'h4' });
    if (!data || !data.length) return null;
    const total = data.reduce((sum, d) => sum + (d.openInterest || 0), 0);
    const totalUsd = data.reduce((sum, d) => sum + (d.openInterestAmount || 0), 0);
    return {
      total_contracts: total,
      total_usd: totalUsd,
      exchanges: data.length,
    };
  } catch (e) {
    log(`  OI failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// Get long/short ratio
async function getLongShortRatio(symbol) {
  try {
    const data = await cgFetch('/long_short', { symbol, time_type: 'h1' });
    if (!data || !data.length) return null;
    // Most recent
    const latest = data[data.length - 1] || data[0];
    return {
      long_rate: latest.longRate,
      short_rate: latest.shortRate,
      long_short_ratio: latest.longShortRatio,
    };
  } catch (e) {
    log(`  L/S ratio failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// Get liquidation data (24h)
async function getLiquidations(symbol) {
  try {
    const data = await cgFetch('/liquidation_history', { symbol, time_type: 'h24' });
    if (!data || !data.length) return null;
    const latest = data[data.length - 1] || data[0];
    return {
      long_liq_usd: latest.longLiquidationUsd,
      short_liq_usd: latest.shortLiquidationUsd,
      total_liq_usd: (latest.longLiquidationUsd || 0) + (latest.shortLiquidationUsd || 0),
      dominant: (latest.shortLiquidationUsd || 0) > (latest.longLiquidationUsd || 0) ? 'shorts' : 'longs',
    };
  } catch (e) {
    log(`  Liquidation data failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ── Verdict logic ───────────────────────────────────────────────────────────
function computeVerdict(setup, funding, oi, lsRatio, liquidations) {
  if (!setup) return { verdict: 'no_setup', adjustment: 0, reasons: [] };

  const isLong = setup.dir === 'LONG';
  let adjustment = 0;
  const reasons = [];

  // Funding rate analysis
  if (funding) {
    const rate = funding.rate;
    if (rate > 0.01) {
      // High positive = longs paying shorts = crowded long
      adjustment += isLong ? -5 : 5;
      reasons.push(`Funding ${(rate * 100).toFixed(3)}% (positive = longs crowded → ${isLong ? 'against' : 'supports'} trade)`);
    } else if (rate < -0.01) {
      // Negative = shorts paying longs = crowded short
      adjustment += isLong ? 5 : -5;
      reasons.push(`Funding ${(rate * 100).toFixed(3)}% (negative = shorts crowded → ${isLong ? 'supports' : 'against'} trade)`);
    } else {
      reasons.push(`Funding ${(rate * 100).toFixed(3)}% (neutral)`);
    }
  }

  // Long/short ratio
  if (lsRatio) {
    const ratio = lsRatio.long_short_ratio;
    if (ratio > 1.5) {
      adjustment += isLong ? -3 : 3;
      reasons.push(`L/S ratio ${ratio.toFixed(2)} (long heavy → ${isLong ? 'crowded' : 'squeeze potential'})`);
    } else if (ratio < 0.7) {
      adjustment += isLong ? 3 : -3;
      reasons.push(`L/S ratio ${ratio.toFixed(2)} (short heavy → ${isLong ? 'squeeze potential' : 'crowded'})`);
    } else {
      reasons.push(`L/S ratio ${ratio.toFixed(2)} (balanced)`);
    }
  }

  // Liquidation analysis
  if (liquidations) {
    if (liquidations.dominant === 'shorts' && isLong) {
      adjustment += 5;
      reasons.push(`Short liquidations dominant ($${(liquidations.short_liq_usd / 1e6).toFixed(1)}M) → supports long (short squeeze)`);
    } else if (liquidations.dominant === 'longs' && !isLong) {
      adjustment += 5;
      reasons.push(`Long liquidations dominant ($${(liquidations.long_liq_usd / 1e6).toFixed(1)}M) → supports short (long squeeze)`);
    } else if (liquidations.dominant === 'shorts' && !isLong) {
      adjustment -= 3;
      reasons.push(`Short liquidations dominant → shorts already getting squeezed, risky to short more`);
    } else {
      adjustment -= 3;
      reasons.push(`Long liquidations dominant → longs already getting squeezed, risky to long more`);
    }
  }

  const verdict = adjustment >= 5 ? 'supports_trade' :
                  adjustment <= -5 ? 'against_trade' : 'neutral';

  return { verdict, adjustment, reasons };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log('=== CoinGlass Liquidation & Funding Check ===');

  // Get symbols from args or latest scan
  let symbols = [];
  let scan = null;

  if (args.symbol) {
    symbols = args.symbol.split(',').map(s => s.trim().toUpperCase());
  } else {
    const scanPath = `${OUTPUT_DIR}/latest.json`;
    if (existsSync(scanPath)) {
      scan = JSON.parse(readFileSync(scanPath, 'utf-8'));
      symbols = scan.setups.map(s => s.symbol);
    }
    if (!symbols.length) {
      log('No symbols found. Pass --symbol or run crypto-scanner.js first.');
      process.exit(1);
    }
  }

  log(`Checking ${symbols.length} symbols: ${symbols.join(', ')}`);

  const results = [];
  for (const sym of symbols) {
    log(`\n  Checking ${sym}...`);

    const [funding, oi, lsRatio, liquidations] = await Promise.all([
      getFundingRate(sym),
      getOpenInterest(sym),
      getLongShortRatio(sym),
      getLiquidations(sym),
    ]);

    const setup = scan?.setups?.find(s => s.symbol === sym);
    const verdict = computeVerdict(setup, funding, oi, lsRatio, liquidations);

    results.push({
      symbol: sym,
      funding,
      open_interest: oi,
      long_short_ratio: lsRatio,
      liquidations,
      setup: setup ? { dir: setup.dir, entry: setup.entry, sl: setup.sl, tp1: setup.tp1, confidence: setup.confidence } : null,
      ...verdict,
    });

    await sleep(300); // Rate limit courtesy
  }

  const output = {
    ts: new Date().toISOString(),
    scan_ts: scan?.ts || null,
    results,
    // Also keep Chrome URLs for visual heatmap confirmation
    chrome_urls: {
      heatmap: 'https://www.coinglass.com/pro/futures/LiquidationHeatMap',
      liquidations: 'https://www.coinglass.com/liquidations',
    },
  };

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(`${OUTPUT_DIR}/liq-check.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));

  // Summary
  log('\n=== Summary ===');
  for (const r of results) {
    const icon = r.verdict === 'supports_trade' ? '✅' : r.verdict === 'against_trade' ? '❌' : '⚠️';
    log(`  ${icon} ${r.symbol}: ${r.verdict} (adj: ${r.adjustment > 0 ? '+' : ''}${r.adjustment})`);
    for (const reason of r.reasons) log(`     ${reason}`);
  }
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
