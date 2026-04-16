#!/usr/bin/env node
/**
 * Sn1P3r Premium 2.0 — Signal Monitor & Analyzer
 * Watches for new BUY/SELL signals, then auto-evaluates quality
 * against BTrader Concept 2.0, Toolkits, ICT structure, and Volume Delta
 */
import { execSync } from 'child_process';

const CLI    = 'node src/cli/index.js';
const CWD    = 'C:/TradingView Bot/tradingview-mcp';
const POLL   = 4000;   // signal check every 4s
const HBEAT  = 60000;  // heartbeat every 60s

const ts  = () => new Date().toTimeString().slice(0, 8);
const log = (m) => console.log(`[${ts()}] ${m}`);
const div = () => console.log('═'.repeat(65));
const run = (cmd, timeout = 8000) => {
  try {
    return JSON.parse(execSync(`${CLI} ${cmd}`, { cwd: CWD, timeout, encoding: 'utf8' }));
  } catch { return null; }
};

// ── STATE ─────────────────────────────────────────────────────
let knownLabelIds  = new Set();   // track seen labels by price+text key
let initialized    = false;
let signalCount    = 0;
let lastHeartbeat  = Date.now();

// ── SIGNAL PARSER ─────────────────────────────────────────────
// Sn1P3r Premium signals appear as labels with text containing
// BUY/SELL, Entry, SL, TP levels — often multi-line or adjacent labels
function parseSignalFromLabels(labels) {
  const signals = [];
  const text = labels.map(l => l.text || '').join('\n');

  // Pattern: look for BUY or SELL signal labels with price data
  // Common formats: "🟢 BUY", "🔴 SELL", "LONG", "SHORT"
  // with nearby TP/SL labels
  const buyPatterns  = [/\bBUY\b/i, /\bLONG\b/i, /🟢/, /▲.*signal/i];
  const sellPatterns = [/\bSELL\b/i, /\bSHORT\b/i, /🔴/, /▼.*signal/i];
  const entryPat     = /entry[:\s]*([0-9,]+\.?[0-9]*)/i;
  const slPat        = /(?:sl|stop|stoploss)[:\s]*([0-9,]+\.?[0-9]*)/i;
  const tp1Pat       = /tp\s*1[:\s]*([0-9,]+\.?[0-9]*)/i;
  const tp2Pat       = /tp\s*2[:\s]*([0-9,]+\.?[0-9]*)/i;
  const tp3Pat       = /tp\s*3[:\s]*([0-9,]+\.?[0-9]*)/i;

  const isBuy  = buyPatterns.some(p => p.test(text));
  const isSell = sellPatterns.some(p => p.test(text));

  if (!isBuy && !isSell) return null;

  // Try to parse from concatenated text
  const parsePrice = (pat) => {
    const m = text.match(pat);
    return m ? parseFloat(m[1].replace(',', '')) : null;
  };

  const entry = parsePrice(entryPat);
  const sl    = parsePrice(slPat);
  const tp1   = parsePrice(tp1Pat);
  const tp2   = parsePrice(tp2Pat);
  const tp3   = parsePrice(tp3Pat);

  // Fallback: if no structured text, use label prices directly
  // Premium often places labels at exact price levels
  const priceSorted = [...labels].sort((a, b) => b.price - a.price);

  return {
    direction: isBuy ? 'BUY' : 'SELL',
    entry:  entry || labels.find(l => /entry/i.test(l.text))?.price || null,
    sl:     sl    || labels.find(l => /stop|sl/i.test(l.text))?.price || null,
    tp1:    tp1   || labels.find(l => /tp.*1|target.*1/i.test(l.text))?.price || null,
    tp2:    tp2   || labels.find(l => /tp.*2|target.*2/i.test(l.text))?.price || null,
    tp3:    tp3   || labels.find(l => /tp.*3|target.*3/i.test(l.text))?.price || null,
    rawLabels: labels,
  };
}

// ── SIGNAL EVALUATOR ──────────────────────────────────────────
async function evaluateSignal(signal, newLabels) {
  signalCount++;
  div();
  log(`🚨 NEW Sn1P3r Premium 2.0 SIGNAL #${signalCount}`);
  div();

  // Print raw signal
  console.log(`\n  Direction : ${signal.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'}`);
  if (signal.entry) console.log(`  Entry     : ${signal.entry}`);
  if (signal.sl)    console.log(`  Stop Loss : ${signal.sl}`);
  if (signal.tp1)   console.log(`  TP 1      : ${signal.tp1}`);
  if (signal.tp2)   console.log(`  TP 2      : ${signal.tp2}`);
  if (signal.tp3)   console.log(`  TP 3      : ${signal.tp3}`);
  if (!signal.entry) {
    console.log('\n  Raw labels from Premium:');
    newLabels.forEach(l => console.log(`    price:${l.price}  text:"${l.text}"`));
  }

  // R:R calculation
  if (signal.entry && signal.sl && signal.tp1) {
    const risk   = Math.abs(signal.entry - signal.sl);
    const rr1    = signal.tp1 ? (Math.abs(signal.tp1 - signal.entry) / risk).toFixed(2) : '?';
    const rr2    = signal.tp2 ? (Math.abs(signal.tp2 - signal.entry) / risk).toFixed(2) : '?';
    const rr3    = signal.tp3 ? (Math.abs(signal.tp3 - signal.entry) / risk).toFixed(2) : '?';
    console.log(`\n  Risk      : ${risk.toFixed(2)} pts`);
    console.log(`  R:R       : TP1=${rr1}R  TP2=${rr2}R  TP3=${rr3}R`);
  }

  console.log('\n  Fetching market context for evaluation...\n');

  // Pull all context in parallel via sequential CLI calls
  const [quote, tables, ohlcv, premLabels] = await Promise.all([
    Promise.resolve(run('quote')),
    Promise.resolve(run('data tables')),
    Promise.resolve(run('ohlcv --summary')),
    Promise.resolve(run('data labels --study-filter "Premium"')),
  ]);

  const price = quote?.last || quote?.close;

  // ── CONTEXT SCORING ────────────────────────────────────────
  let score = 0;       // +1 = confirms signal, -1 = contradicts
  const pros = [];
  const cons = [];
  const neutral = [];

  // 1. BTrader MTF alignment
  let trend15 = null, trend30 = null, trend1h = null, trend4h = null;
  let sessionTrend = null, market = null, inst = null, cycle = null;

  for (const study of (tables?.studies || [])) {
    if (!study.name.includes('BTrader Conept')) continue;
    for (const tbl of (study.tables || [])) {
      for (const row of (tbl.rows || [])) {
        const m15  = row.match(/15m:\s*(🟢|🔴)/);  if (m15) trend15 = m15[1];
        const m30  = row.match(/30m:\s*(🟢|🔴)/);  if (m30) trend30 = m30[1];
        const m1h  = row.match(/1H:\s*(🟢|🔴)/);   if (m1h) trend1h = m1h[1];
        const m4h  = row.match(/4H:\s*(🟢|🔴)/);   if (m4h) trend4h = m4h[1];
        const mT   = row.match(/Trend:\s*(🐂|🐻)/); if (mT) sessionTrend = mT[1];
        const mM   = row.match(/Market:\s*(📈|📉)/);if (mM) market = mM[1];
        const mI   = row.match(/Inst:\s*(✅|❌)/);  if (mI) inst = mI[1];
        const mC   = row.match(/Cycle:\s*(.+)/);    if (mC) cycle = mC[1].trim();
      }
    }
  }

  // MTF alignment check
  const isBuy = signal.direction === 'BUY';
  const bullColor = '🟢', bearColor = '🔴';
  const bullTrend = '🐂', bearTrend = '🐻';

  if (trend4h) {
    const aligns = isBuy ? trend4h === bullColor : trend4h === bearColor;
    aligns
      ? (score += 2, pros.push(`4H trend aligned ${trend4h}`))
      : (score -= 2, cons.push(`4H trend AGAINST signal ${trend4h}`));
  }
  if (trend1h) {
    const aligns = isBuy ? trend1h === bullColor : trend1h === bearColor;
    aligns
      ? (score += 1, pros.push(`1H trend aligned ${trend1h}`))
      : (score -= 1, cons.push(`1H trend against signal ${trend1h}`));
  }
  if (trend15) {
    const aligns = isBuy ? trend15 === bullColor : trend15 === bearColor;
    aligns
      ? (score += 1, pros.push(`15m trend aligned ${trend15}`))
      : (score -= 1, cons.push(`15m trend against signal ${trend15}`));
  }
  if (sessionTrend) {
    const aligns = isBuy ? sessionTrend === bullTrend : sessionTrend === bearTrend;
    aligns
      ? (score += 2, pros.push(`Session trend aligned ${sessionTrend}`))
      : (score -= 2, cons.push(`Session trend AGAINST signal ${sessionTrend}`));
  }
  if (market) {
    const aligns = isBuy ? market === '📈' : market === '📉';
    aligns
      ? (score += 1, pros.push(`Market direction aligned ${market}`))
      : (score -= 1, cons.push(`Market direction against ${market}`));
  }
  if (inst === '✅') {
    score += 2;
    pros.push('🏦 Institutional flow CONFIRMED — highest conviction boost');
  } else {
    score -= 1;
    cons.push('🏦 Institutional flow absent ❌');
  }
  if (cycle) neutral.push(`Macro cycle: ${cycle}`);

  // 2. Price vs session opens (from BTrader Premium labels)
  const premStudy = premLabels?.studies?.find(s => s.name.includes('Premium'));
  const nyClosed  = premStudy?.labels?.find(l => l.text === 'NewYork');
  if (nyClosed && price) {
    const nyPrice = nyClosed.price;
    const aboveNY = price > nyPrice;
    if (isBuy && aboveNY)  { score += 1; pros.push(`Price above NY open (${nyPrice}) — bullish NY session`); }
    if (isBuy && !aboveNY) { score -= 1; cons.push(`Price BELOW NY open (${nyPrice}) — bearish NY session`); }
    if (!isBuy && !aboveNY){ score += 1; pros.push(`Price below NY open (${nyPrice}) — bearish NY session confirmed`); }
    if (!isBuy && aboveNY) { score -= 1; cons.push(`Price above NY open (${nyPrice}) — NY session bullish`); }
  }

  // 3. Sn1P3r Premium structure (BOS/CHoCH)
  if (premStudy) {
    const recentLabels = premStudy.labels.slice(-6);
    const lastBOS  = recentLabels.filter(l => l.text === 'BOS').slice(-1)[0];
    const lastChoch = recentLabels.filter(l => l.text === 'CHoCH').slice(-1)[0];
    if (lastBOS) neutral.push(`Last BOS at ${lastBOS.price}`);
    if (lastChoch) {
      const chochAbove = lastChoch.price > (price || 0);
      if (!isBuy && chochAbove) { score += 1; pros.push(`CHoCH above price (${lastChoch.price}) — bearish flip confirmed`); }
      if (isBuy && !chochAbove) { score += 1; pros.push(`CHoCH below price (${lastChoch.price}) — bullish flip confirmed`); }
    }
    // CBDR context
    const cbdr = premStudy.labels.filter(l => l.text === 'CBDR');
    if (cbdr.length >= 2) {
      const cbdrH = Math.max(...cbdr.map(l => l.price));
      const cbdrL = Math.min(...cbdr.map(l => l.price));
      neutral.push(`CBDR range: ${cbdrL} – ${cbdrH}`);
      if (price) {
        if (price < cbdrL) neutral.push(`Price BELOW CBDR — extended bearish`);
        if (price > cbdrH) neutral.push(`Price ABOVE CBDR — extended bullish`);
        if (price >= cbdrL && price <= cbdrH) neutral.push(`Price INSIDE CBDR — range/consolidation`);
      }
    }
  }

  // 4. OHLCV context
  if (ohlcv) {
    const pct = parseFloat(ohlcv.change_pct);
    if (!isNaN(pct)) {
      if (isBuy && pct > 0.1)  { score += 1; pros.push(`Session up ${ohlcv.change_pct} — momentum with BUY`); }
      if (isBuy && pct < -0.3) { score -= 1; cons.push(`Session down ${ohlcv.change_pct} — counter-trend BUY`); }
      if (!isBuy && pct < -0.1){ score += 1; pros.push(`Session down ${ohlcv.change_pct} — momentum with SELL`); }
      if (!isBuy && pct > 0.3) { score -= 1; cons.push(`Session up ${ohlcv.change_pct} — counter-trend SELL`); }
    }
    neutral.push(`Session range: ${ohlcv.range} pts (ADR 91.7) | Used: ${((ohlcv.range/91.7)*100).toFixed(0)}%`);
  }

  // 5. Killzone check
  for (const study of (tables?.studies || [])) {
    if (!study.name.includes('Toolkit')) continue;
    for (const tbl of (study.tables || [])) {
      for (const row of (tbl.rows || [])) {
        if (row.includes('Killzone') && !row.includes('Out of')) {
          score += 1;
          pros.push(`Active Killzone — high probability window`);
        }
        if (row.includes('Out of Killzone')) {
          score -= 1;
          cons.push(`Outside Killzone — lower probability timing`);
        }
      }
    }
  }

  // ── VERDICT ────────────────────────────────────────────────
  const maxScore = 12;
  const pct = Math.round(((score + maxScore) / (maxScore * 2)) * 100);
  let verdict, emoji;
  if (score >= 5)       { verdict = 'STRONG SIGNAL ✅ — HIGH QUALITY';   emoji = '🟢'; }
  else if (score >= 2)  { verdict = 'GOOD SIGNAL ✅ — TAKE IT';          emoji = '🟡'; }
  else if (score >= 0)  { verdict = 'MARGINAL SIGNAL ⚠️ — PROCEED WITH CAUTION'; emoji = '🟡'; }
  else if (score >= -2) { verdict = 'WEAK SIGNAL ❌ — SKIP OR REDUCE SIZE'; emoji = '🟠'; }
  else                  { verdict = 'BAD SIGNAL ❌ — DO NOT TRADE';       emoji = '🔴'; }

  // ── OUTPUT ─────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(65));
  console.log('  SIGNAL EVALUATION REPORT');
  console.log('─'.repeat(65));
  console.log(`\n  ${emoji} VERDICT: ${verdict}`);
  console.log(`  Score: ${score > 0 ? '+' : ''}${score} / +${maxScore}  (${pct}% confidence)`);
  console.log(`  Price at signal: ${price || '?'}`);

  if (pros.length) {
    console.log('\n  ✅ CONFIRMING FACTORS:');
    pros.forEach(p => console.log(`    + ${p}`));
  }
  if (cons.length) {
    console.log('\n  ❌ CONFLICTING FACTORS:');
    cons.forEach(c => console.log(`    − ${c}`));
  }
  if (neutral.length) {
    console.log('\n  ℹ️  CONTEXT:');
    neutral.forEach(n => console.log(`    · ${n}`));
  }

  // R:R reminder
  if (signal.entry && signal.sl && signal.tp1) {
    const risk = Math.abs(signal.entry - signal.sl);
    console.log('\n  📐 TRADE LEVELS:');
    console.log(`    Entry : ${signal.entry}`);
    console.log(`    SL    : ${signal.sl}  (${risk.toFixed(1)} pts risk)`);
    if (signal.tp1) console.log(`    TP1   : ${signal.tp1}  (R:R ${(Math.abs(signal.tp1 - signal.entry)/risk).toFixed(1)})`);
    if (signal.tp2) console.log(`    TP2   : ${signal.tp2}  (R:R ${(Math.abs(signal.tp2 - signal.entry)/risk).toFixed(1)})`);
    if (signal.tp3) console.log(`    TP3   : ${signal.tp3}  (R:R ${(Math.abs(signal.tp3 - signal.entry)/risk).toFixed(1)})`);
  }

  console.log('\n' + '═'.repeat(65) + '\n');
}

// ── LABEL TRACKER ─────────────────────────────────────────────
function labelKey(l) { return `${l.text}|${l.price}`; }

async function pollSignals() {
  const data = run('data labels --study-filter "Premium"');
  if (!data?.studies) return;

  const premStudy = data.studies.find(s => s.name.includes('Premium'));
  if (!premStudy?.labels) return;

  const currentLabels = premStudy.labels;

  if (!initialized) {
    // First run — seed known labels, don't fire alerts
    currentLabels.forEach(l => knownLabelIds.add(labelKey(l)));
    initialized = true;
    log(`📡 Sn1P3r Premium seeded — tracking ${knownLabelIds.size} existing labels`);
    log(`   Watching for: BUY/SELL signals with Entry, SL, TP1/2/3`);
    return;
  }

  // Find new labels
  const newLabels = currentLabels.filter(l => !knownLabelIds.has(labelKey(l)));
  if (newLabels.length === 0) return;

  // Add to known
  newLabels.forEach(l => knownLabelIds.add(labelKey(l)));

  log(`📌 ${newLabels.length} new Premium label(s): ${newLabels.map(l => `"${l.text}"@${l.price}`).join(', ')}`);

  // Check if any new label contains signal keywords
  const signalLabels = newLabels.filter(l => {
    const t = (l.text || '').toLowerCase();
    return t.includes('buy') || t.includes('sell') || t.includes('long') || t.includes('short') ||
           t.includes('entry') || t.includes('tp') || t.includes('sl') || t.includes('stop') ||
           t.includes('target') || l.text.includes('🟢') || l.text.includes('🔴') ||
           l.text.includes('▲') || l.text.includes('▼');
  });

  // Also check if multiple new labels appeared at once (typical for signal blocks)
  const labelsToAnalyze = signalLabels.length > 0 ? signalLabels :
                          newLabels.length >= 3 ? newLabels : [];

  if (labelsToAnalyze.length > 0) {
    const signal = parseSignalFromLabels(labelsToAnalyze);
    if (signal) {
      await evaluateSignal(signal, labelsToAnalyze);
    } else {
      // Signal detected but couldn't parse structured levels — still report
      log(`⚡ Signal-like labels detected — analyzing context...`);
      await evaluateSignal({
        direction: labelsToAnalyze.some(l => /buy|long|🟢|▲/i.test(l.text || '')) ? 'BUY' : 'SELL',
        entry: labelsToAnalyze[0]?.price,
        sl: null, tp1: null, tp2: null, tp3: null,
        rawLabels: labelsToAnalyze
      }, labelsToAnalyze);
    }
  }
}

// ── HEARTBEAT ─────────────────────────────────────────────────
function heartbeat() {
  const q = run('quote');
  const price = q?.last || q?.close || '?';
  log(`💓 ALIVE | price:${price} | signals caught:${signalCount} | labels tracked:${knownLabelIds.size}`);
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log('');
  div();
  console.log('  Sn1P3r Premium 2.0 — Signal Monitor & Auto-Evaluator');
  div();
  console.log('  Watches every 4s for new BUY/SELL signals from Premium');
  console.log('  On signal: auto-evaluates against BTrader + ICT context');
  console.log('  Rates signal: STRONG / GOOD / MARGINAL / WEAK / BAD');
  console.log('  Ctrl+C to stop');
  div();
  console.log('');

  await pollSignals();  // seed initial state

  setInterval(pollSignals, POLL);
  setInterval(heartbeat, HBEAT);

  process.stdin.resume();
  process.on('SIGINT', () => { log('Signal monitor stopped.'); process.exit(0); });
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
