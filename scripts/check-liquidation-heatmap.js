#!/usr/bin/env node
/**
 * Liquidation Heatmap Checker via CoinGlass
 * Called by the master orchestrator after scanner finds candidates.
 * Reads latest scan, checks liquidation data for each setup.
 *
 * Usage: node scripts/check-liquidation-heatmap.js [--symbol BTCUSDT]
 *
 * This script outputs JSON with liquidation context per symbol.
 * The Chrome automation is done by Claude via MCP tools — this script
 * just prepares the URLs and parses the orchestrator output.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';

const OUTPUT_DIR = '/Users/apex/tradingview-mcp/scans';

const { values: args } = parseArgs({
  options: {
    symbol: { type: 'string', default: '' },
  },
  strict: false,
});

function getHeatmapUrl(symbol) {
  // CoinGlass liquidation heatmap — single page, use pair dropdown to switch
  return `https://www.coinglass.com/pro/futures/LiquidationHeatMap`;
}

function getLiquidationsUrl(symbol) {
  return `https://www.coinglass.com/liquidations`;
}

function getCurrencyUrl(symbol) {
  return `https://www.coinglass.com/currencies/${symbol}`;
}

// Read latest scan
function getLatestSetups() {
  const path = `${OUTPUT_DIR}/latest.json`;
  if (!existsSync(path)) {
    console.error('No latest scan found. Run crypto-scanner.js first.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function main() {
  const scan = getLatestSetups();

  const symbols = args.symbol
    ? [args.symbol]
    : scan.setups.map(s => s.symbol);

  const checks = symbols.map(sym => {
    const setup = scan.setups.find(s => s.symbol === sym);
    return {
      symbol: sym,
      coinglass_heatmap_url: getHeatmapUrl(sym),
      coinglass_liq_url: getLiquidationsUrl(sym),
      coinglass_currency_url: getCurrencyUrl(sym),
      setup: setup ? {
        dir: setup.dir,
        entry: setup.entry,
        sl: setup.sl,
        tp1: setup.tp1,
        tp2: setup.tp2,
        tp3: setup.tp3,
        confidence: setup.confidence,
      } : null,
      // These fields are populated by Claude after checking Chrome
      liq_clusters_above: [],
      liq_clusters_below: [],
      liq_verdict: 'pending_chrome_check',
    };
  });

  const output = {
    ts: new Date().toISOString(),
    scan_ts: scan.ts,
    symbols_to_check: checks,
    instructions: `
Use Claude in Chrome MCP to:
1. Navigate to each coinglass_url
2. Screenshot the liquidation heatmap
3. Read the page text for liquidation clusters
4. Determine if liquidation pools align with the trade direction
5. Update liq_verdict to: "supports_trade", "against_trade", or "neutral"
    `.trim(),
  };

  writeFileSync(`${OUTPUT_DIR}/liq-check.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
}

main();
