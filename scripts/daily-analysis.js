#!/usr/bin/env node
/**
 * Daily options analysis — runs at 8am via launchd.
 * Iterates top 20 watchlist stocks, collects technicals via MCP,
 * generates a dark-theme HTML dashboard and opens it in the browser.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const MCP_URL = process.env.MCP_URL || 'http://127.0.0.1:3000/mcp';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPORTS_DIR = join(ROOT, 'reports');

// Top 20 from watchlist — individual stocks only (no ETFs/indices)
const SYMBOLS = [
  'TSLA', 'MSTR', 'MSFT', 'CRWV', 'COIN',
  'META', 'NVDA', 'UBER', 'LLY',  'NFLX',
  'MU',   'AMD',  'PLTR', 'DELL', 'LUNR',
  'GOOG', 'ARM',  'AAPL', 'HOOD', 'PANW',
];

// ─── MCP helpers ─────────────────────────────────────────────────────────────

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Per-stock data collection ────────────────────────────────────────────────

async function analyzeStock(client, symbol) {
  await callTool(client, 'chart_set_symbol', { symbol });
  await sleep(2500);

  const [quote, ohlcvD, ohlcvW, studies] = await Promise.all([
    callTool(client, 'quote_get', {}),
    callTool(client, 'data_get_ohlcv', { summary: true }),
    callTool(client, 'data_get_ohlcv', { summary: true }),
    callTool(client, 'data_get_study_values', {}),
  ]);

  return { symbol, quote, ohlcvD, studies };
}

// ─── Analysis logic ───────────────────────────────────────────────────────────

function analyze(symbol, quote, ohlcvD, studies) {
  const studyList = studies?.studies ?? [];

  const rsiStudy  = studyList.find(s => s.name.includes('RSI') || s.name.includes('Relative Strength'));
  const bbStudy   = studyList.find(s => s.name.includes('Bollinger'));
  const emaStudy  = studyList.find(s => s.name.includes('EMA'));
  const atrStudy  = studyList.find(s => s.name.includes('ATR') || s.name.includes('Average True Range'));
  const cmfStudy  = studyList.find(s => s.name.includes('Chaikin') || s.name.includes('CMF'));

  const rsi    = rsiStudy  ? parseFloat(Object.values(rsiStudy.values)[0])  : null;
  const bbBasis = bbStudy  ? parseFloat(bbStudy.values['Basis'])             : null;
  const bbUpper = bbStudy  ? parseFloat(bbStudy.values['Upper'])             : null;
  const bbLower = bbStudy  ? parseFloat(bbStudy.values['Lower'])             : null;
  const atr    = atrStudy  ? parseFloat(Object.values(atrStudy.values)[0])  : null;
  const cmf    = cmfStudy  ? parseFloat(Object.values(cmfStudy.values)[0])  : null;

  const close      = ohlcvD?.close  ?? quote?.last  ?? null;
  const changePct  = ohlcvD?.change_pct ?? null;
  const avgVol     = ohlcvD?.avg_volume ?? null;
  const lastVol    = ohlcvD?.last_5_bars?.at(-1)?.volume ?? null;
  const volRatio   = avgVol && lastVol ? lastVol / avgVol : null;

  const aboveBasis = bbBasis && close ? close > bbBasis : null;
  const nearUpper  = bbUpper && close ? close > bbUpper * 0.98 : false;
  const nearLower  = bbLower && close ? close < bbLower * 1.02 : false;

  // Scoring: +1 bullish signal, -1 bearish signal
  let score = 0;
  const signals = [];

  if (rsi !== null) {
    if (rsi > 60)       { score += 1; signals.push(`RSI ${rsi.toFixed(0)} (strong)`); }
    else if (rsi > 50)  { score += 0.5; signals.push(`RSI ${rsi.toFixed(0)}`); }
    else if (rsi < 40)  { score -= 1; signals.push(`RSI ${rsi.toFixed(0)} (weak)`); }
    else if (rsi < 50)  { score -= 0.5; signals.push(`RSI ${rsi.toFixed(0)}`); }
  }
  if (aboveBasis !== null) {
    if (aboveBasis)  { score += 1; signals.push('Above BB basis'); }
    else             { score -= 1; signals.push('Below BB basis'); }
  }
  if (cmf !== null) {
    if (cmf > 0.1)   { score += 0.5; signals.push(`CMF +${cmf.toFixed(2)}`); }
    else if (cmf < -0.1) { score -= 0.5; signals.push(`CMF ${cmf.toFixed(2)}`); }
  }
  if (volRatio !== null && volRatio > 1.5) {
    signals.push(`Vol ${(volRatio * 100).toFixed(0)}% of avg`);
  }

  // Determine bias and action
  let bias, action, cls;

  if (nearUpper && score > 1) {
    bias = 'Extended'; action = 'Sell Calls / Take Profit'; cls = 'caution';
  } else if (nearLower && score < -1) {
    bias = 'Oversold'; action = 'Sell Puts / Take Profit'; cls = 'caution';
  } else if (score >= 2) {
    bias = 'Bullish'; action = 'Buy Calls'; cls = 'bullish';
  } else if (score >= 1) {
    bias = 'Mild Bullish'; action = 'Calls (small)'; cls = 'mild-bullish';
  } else if (score <= -2) {
    bias = 'Bearish'; action = 'Buy Puts'; cls = 'bearish';
  } else if (score <= -1) {
    bias = 'Mild Bearish'; action = 'Puts (small)'; cls = 'mild-bearish';
  } else {
    bias = 'Neutral'; action = 'Sell Premium'; cls = 'neutral';
  }

  return {
    symbol, close, changePct, volRatio, rsi, bbBasis, bbUpper, bbLower,
    atr, cmf, aboveBasis, score, signals, bias, action, cls,
    high: ohlcvD?.high, low: ohlcvD?.low,
  };
}

// ─── HTML generation ──────────────────────────────────────────────────────────

function generateHTML(rows, timestamp) {
  const SORT_ORDER = { bullish: 0, 'mild-bullish': 1, caution: 2, neutral: 3, 'mild-bearish': 4, bearish: 5 };
  rows.sort((a, b) => (SORT_ORDER[a.cls] ?? 9) - (SORT_ORDER[b.cls] ?? 9));

  const tableRows = rows.map(r => {
    const chg = parseFloat(r.changePct);
    const chgStr = isNaN(chg) ? '—' : `${chg > 0 ? '+' : ''}${r.changePct}`;
    const chgCls = chg > 0 ? 'pos' : chg < 0 ? 'neg' : '';
    const rsiStr = r.rsi != null ? r.rsi.toFixed(1) : '—';
    const rsiCls = r.rsi > 70 ? 'overbought' : r.rsi < 30 ? 'oversold' : '';
    const volStr = r.volRatio != null ? `${(r.volRatio * 100).toFixed(0)}%` : '—';
    const volCls = r.volRatio > 1.5 ? 'high-vol' : '';
    const rangeStr = r.high != null ? `${r.low} – ${r.high}` : '—';
    const priceStr = r.close != null ? `$${r.close}` : '—';
    const sigStr = r.signals?.join(' · ') || '—';

    return `<tr>
      <td class="sym">${r.symbol}</td>
      <td>${priceStr}</td>
      <td class="chg ${chgCls}">${chgStr}</td>
      <td class="rsi ${rsiCls}">${rsiStr}</td>
      <td class="range">${rangeStr}</td>
      <td class="${volCls}">${volStr}</td>
      <td class="signals">${sigStr}</td>
      <td class="bias ${r.cls}">${r.bias}</td>
      <td class="action ${r.cls}">${r.action}</td>
    </tr>`;
  }).join('\n');

  // Summary counts
  const bullCount = rows.filter(r => r.cls === 'bullish' || r.cls === 'mild-bullish').length;
  const bearCount = rows.filter(r => r.cls === 'bearish' || r.cls === 'mild-bearish').length;
  const neutCount = rows.filter(r => r.cls === 'neutral' || r.cls === 'caution').length;
  const marketBias = bullCount > bearCount + 2 ? '📈 Bullish' : bearCount > bullCount + 2 ? '📉 Bearish' : '↔️ Mixed';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Daily Analysis · ${timestamp}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#131722;color:#d1d4dc;font-family:'Trebuchet MS',Arial,sans-serif;font-size:13px;padding:24px}
  h1{color:#fff;font-size:18px;font-weight:700;margin-bottom:4px}
  .meta{color:#787b86;font-size:12px;margin-bottom:18px}
  .summary{display:flex;gap:24px;margin-bottom:20px;padding:14px 18px;background:#1e2130;border-radius:6px;border-left:3px solid #2962ff}
  .summary-item{display:flex;flex-direction:column;gap:3px}
  .summary-label{font-size:11px;color:#787b86;text-transform:uppercase;letter-spacing:.5px}
  .summary-val{font-size:16px;font-weight:700}
  .bull{color:#26a69a}.bear{color:#ef5350}.neut{color:#787b86}
  table{width:100%;border-collapse:collapse}
  thead th{background:#1a1e2e;color:#787b86;text-align:left;padding:9px 12px;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid #2a2e39;position:sticky;top:0;z-index:1}
  td{padding:9px 12px;border-bottom:1px solid #1a1e2e;vertical-align:middle}
  tr:hover td{background:#1e2130}
  .sym{font-weight:700;color:#fff;font-size:14px}
  .pos{color:#26a69a;font-weight:600}
  .neg{color:#ef5350;font-weight:600}
  .overbought{color:#ef5350;font-weight:700}
  .oversold{color:#26a69a;font-weight:700}
  .high-vol{color:#ff9800;font-weight:600}
  .range{color:#787b86;font-size:12px}
  .signals{color:#a0a3ab;font-size:11px;max-width:220px}
  .bias{font-weight:600}
  .action{font-weight:700}
  .bullish{color:#26a69a}
  .mild-bullish{color:#64b5a0}
  .bearish{color:#ef5350}
  .mild-bearish{color:#e57373}
  .caution{color:#ff9800}
  .neutral{color:#787b86}
  .legend{margin-top:16px;display:flex;gap:16px;font-size:11px;color:#787b86;flex-wrap:wrap}
  .legend span{display:inline-flex;align-items:center;gap:5px}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block}
</style>
</head>
<body>
<h1>📊 Daily Options Analysis</h1>
<p class="meta">Generated ${timestamp} · W/1D/4h/1h Framework · Top 20 Watchlist</p>

<div class="summary">
  <div class="summary-item">
    <span class="summary-label">Market Bias</span>
    <span class="summary-val">${marketBias}</span>
  </div>
  <div class="summary-item">
    <span class="summary-label">Bullish Setups</span>
    <span class="summary-val bull">${bullCount}</span>
  </div>
  <div class="summary-item">
    <span class="summary-label">Bearish Setups</span>
    <span class="summary-val bear">${bearCount}</span>
  </div>
  <div class="summary-item">
    <span class="summary-label">Neutral / Caution</span>
    <span class="summary-val neut">${neutCount}</span>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>Symbol</th><th>Price</th><th>Change</th><th>RSI</th>
      <th>Daily Range</th><th>Vol/Avg</th><th>Signals</th>
      <th>Bias</th><th>Action</th>
    </tr>
  </thead>
  <tbody>${tableRows}</tbody>
</table>

<div class="legend">
  <span><span class="dot" style="background:#26a69a"></span>Bullish — Buy Calls</span>
  <span><span class="dot" style="background:#64b5a0"></span>Mild Bullish</span>
  <span><span class="dot" style="background:#ef5350"></span>Bearish — Buy Puts</span>
  <span><span class="dot" style="background:#e57373"></span>Mild Bearish</span>
  <span><span class="dot" style="background:#ff9800"></span>Extended / Caution</span>
  <span><span class="dot" style="background:#787b86"></span>Neutral — Sell Premium</span>
</div>
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const client = new Client({ name: 'daily-analysis', version: '1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));

process.stderr.write(`[daily-analysis] Connected · analyzing ${SYMBOLS.length} stocks\n`);

const rows = [];
for (const symbol of SYMBOLS) {
  process.stderr.write(`  → ${symbol}\n`);
  try {
    const { quote, ohlcvD, studies } = await analyzeStock(client, symbol);
    rows.push(analyze(symbol, quote, ohlcvD, studies));
  } catch (err) {
    process.stderr.write(`  ✗ ${symbol}: ${err.message}\n`);
    rows.push({ symbol, cls: 'neutral', bias: 'Error', action: 'N/A', signals: [err.message] });
  }
}

await client.close();

const timestamp = new Date().toLocaleString('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
});
const html = generateHTML(rows, timestamp);

mkdirSync(REPORTS_DIR, { recursive: true });
const outFile = join(REPORTS_DIR, `daily-${new Date().toISOString().slice(0, 10)}.html`);
writeFileSync(outFile, html);
process.stderr.write(`[daily-analysis] Saved → ${outFile}\n`);

execSync(`open "${outFile}"`);
