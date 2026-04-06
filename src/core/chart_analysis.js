/**
 * ASCII chart visualizations for AI pattern recognition. Requires OHLCV chart types
 * (Candles, Bars, Hollow Candles, Heikin Ashi) — Renko, Kagi, P&F, Line Break unsupported.
 * Patterns ported from anatomy.py; swing detection from ownership.py:label_structure. */
import { getOhlcv } from './data.js';

// ─── Bar Analysis ─────────────────────────────────────────────────────────────

function analyzeBar(bar, prevBar, avgVolume) {
  const bullish = bar.close >= bar.open;
  const body = Math.abs(bar.close - bar.open);
  const range = bar.high - bar.low || 0.0001;
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  const lowerWick = Math.min(bar.open, bar.close) - bar.low;

  const bodyPct = Math.round((body / range) * 100);
  const upperPct = Math.round((upperWick / range) * 100);
  const lowerPct = Math.round((lowerWick / range) * 100);

  let vsHigh = 'Equal', vsLow = 'Equal';
  if (prevBar) {
    if (bar.high > prevBar.high) vsHigh = 'HH';
    else if (bar.high < prevBar.high) vsHigh = 'LH';
    if (bar.low > prevBar.low) vsLow = 'HL';
    else if (bar.low < prevBar.low) vsLow = 'LL';
  }

  const volumeChar =
    avgVolume <= 0 ? 'Unknown' :
    bar.volume > avgVolume * 1.5 ? 'AboveAvg' :
    bar.volume < avgVolume * 0.5 ? 'BelowAvg' : 'Avg';

  // Pattern matching — exact port from anatomy.py
  // bpct is fraction (0-1); move, upperWick, lowerWick are absolute price values
  const move = bar.close - bar.open;
  const bpct = body / range;
  let pattern = null;
  if (bpct > 0.90 && move > 0)                                            pattern = 'Marubozu Bull';
  else if (bpct > 0.90 && move < 0)                                       pattern = 'Marubozu Bear';
  else if (lowerWick > 2*upperWick && lowerWick > 2*Math.abs(move) && bpct < 0.45) pattern = 'Hammer';
  else if (upperWick > 2*lowerWick && upperWick > 2*Math.abs(move) && bpct < 0.45) pattern = 'Shooting Star';
  else if (bpct < 0.05)                                                    pattern = 'Doji';
  else if (bpct < 0.30 && upperWick > 0 && lowerWick > 0)                 pattern = 'Spinning Top';
  else if (move > 0 && bpct > 0.60)                                       pattern = 'Bullish Engulf';
  else if (move < 0 && bpct > 0.60)                                       pattern = 'Bearish Engulf';

  return {
    bullish,
    body: Math.round(body * 100) / 100,
    range: Math.round(range * 100) / 100,
    upperWick: Math.round(upperWick * 100) / 100,
    lowerWick: Math.round(lowerWick * 100) / 100,
    bodyPct, upperPct, lowerPct,
    vsHigh, vsLow,
    volumeChar,
    pattern,
  };
}

// ─── ASCII Renderers ──────────────────────────────────────────────────────────

// Y-axis label at nearest round price tick (~5 labels across the range); blank if not close enough.
const yTick=(p,range,rows,lw)=>{const mag=Math.pow(10,Math.floor(Math.log10(range/5||1)));const t=Math.ceil(range/5/mag)*mag;const r=Math.round(p/t)*t;return Math.abs(p-r)<range/rows/2?(t>=1?r.toFixed(0):r.toFixed(1)).padStart(lw):' '.repeat(lw);};

function buildCandlestickASCII(bars, analyzedBars, rows = 20) {
  if (bars.length === 0) return '';

  const high = Math.max(...bars.map(b => b.high));
  const low = Math.min(...bars.map(b => b.low));
  const priceRange = high - low || 1;
  const toRow = price =>
    Math.min(rows - 1, Math.max(0, Math.round(((high - price) / priceRange) * (rows - 1))));

  // 2 columns per bar: char + space
  const grid = Array.from({ length: rows }, () => new Array(bars.length * 2).fill(' '));

  for (let bi = 0; bi < bars.length; bi++) {
    const bar = bars[bi];
    const bull = analyzedBars[bi].bullish;
    const col = bi * 2;
    const highRow = toRow(bar.high);
    const lowRow = toRow(bar.low);
    const bodyTop = Math.min(toRow(bar.open), toRow(bar.close));
    const bodyBot = Math.max(toRow(bar.open), toRow(bar.close));

    for (let r = highRow; r <= lowRow; r++) {
      grid[r][col] = (r >= bodyTop && r <= bodyBot) ? (bull ? '█' : '▓') : '│';
    }
  }

  const labelWidth = 10;
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const price = high - (r / (rows - 1)) * priceRange;
    lines.push(`${yTick(price, priceRange, rows, labelWidth)} ┤ ${grid[r].join('').trimEnd()}`);
  }
  lines.push(`${' '.repeat(labelWidth)} └${'─'.repeat(bars.length * 2 + 2)}`);
  lines.push('Legend: █=Bullish  ▓=Bearish  │=Wick');

  return lines.join('\n');
}

function buildBarAnatomyASCII(bar, info) {
  const fmt = v => v.toFixed(2);
  const bull = info.bullish;
  const lw = 6, pw = Math.max(...[bar.high,bar.open,bar.close,bar.low].map(v=>fmt(v).length));
  const ind = ' '.repeat(2+lw+1+pw+5); // aligns verticals under the '── ' connector
  const row = (lbl,val,box,note='')=>`  ${lbl.padEnd(lw)} ${fmt(val).padStart(pw)}  ── ${box}${note}`;
  return [
    row('High', bar.high, '│', `  ← Upper wick (${info.upperPct}%)`),
    `${ind}│`,
    bull ? row('Close',bar.close,'╔══╗',`  ← Body (${info.bodyPct}%) [Bullish]`)
         : row('Open', bar.open, '╔══╗',`  ← Body (${info.bodyPct}%) [Bearish]`),
    `${ind}║  ║`,
    bull ? row('Open',bar.open,'╚══╝') : row('Close',bar.close,'╚══╝'),
    `${ind}│`,
    row('Low', bar.low, '│', `  ← Lower wick (${info.lowerPct}%)`),
  ].join('\n');
}

function buildVolumeProfileASCII(priceLevels) {
  const maxVol = Math.max(...priceLevels.map(l => l.total_volume), 1);
  const barWidth = 24;
  const lines = [];
  for (const level of priceLevels) {
    const filled = Math.round((level.total_volume / maxVol) * barWidth);
    const buyFill = level.total_volume > 0
      ? Math.round((level.buying_volume / level.total_volume) * filled) : 0;
    const sellFill = Math.max(0, filled - buyFill);
    const bar = '█'.repeat(buyFill) + '░'.repeat(sellFill);
    const poc = level.is_poc ? ' ← POC' : '';
    const vah = level.is_vah ? ' ← VAH' : '';
    const val = level.is_val ? ' ← VAL' : '';
    lines.push(
      `${level.price.toFixed(2).padStart(10)} ┤ ${bar.padEnd(barWidth)} (${String(level.total_volume).padStart(8)})${poc}${vah}${val}`
    );
  }
  lines.push('Legend: █=Buying  ░=Selling  POC=Point of Control  VAH/VAL=Value Area');
  return lines.join('\n');
}

function buildHeikinAshiASCII(bars, rows = 20) {
  if (bars.length === 0) return '';

  // Convert to Heikin-Ashi
  const ha = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen = i === 0 ? (b.open + b.close) / 2 : (ha[i - 1].open + ha[i - 1].close) / 2;
    const haHigh = Math.max(b.high, haOpen, haClose);
    const haLow = Math.min(b.low, haOpen, haClose);
    ha.push({ open: haOpen, high: haHigh, low: haLow, close: haClose });
  }

  const high = Math.max(...ha.map(b => b.high));
  const low = Math.min(...ha.map(b => b.low));
  const priceRange = high - low || 1;
  const toRow = price =>
    Math.min(rows - 1, Math.max(0, Math.round(((high - price) / priceRange) * (rows - 1))));

  const grid = Array.from({ length: rows }, () => new Array(ha.length * 2).fill(' '));

  for (let bi = 0; bi < ha.length; bi++) {
    const b = ha[bi];
    const bull = b.close >= b.open;
    const col = bi * 2;
    const highRow = toRow(b.high);
    const lowRow = toRow(b.low);
    const bodyTop = Math.min(toRow(b.open), toRow(b.close));
    const bodyBot = Math.max(toRow(b.open), toRow(b.close));

    for (let r = highRow; r <= lowRow; r++) {
      grid[r][col] = (r >= bodyTop && r <= bodyBot) ? (bull ? '█' : '▓') : '│';
    }
  }

  const labelWidth = 10;
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const price = high - (r / (rows - 1)) * priceRange;
    lines.push(`${yTick(price, priceRange, rows, labelWidth)} ┤ ${grid[r].join('').trimEnd()}`);
  }
  lines.push(`${' '.repeat(labelWidth)} └${'─'.repeat(ha.length * 2 + 2)}`);
  lines.push('Legend: █=Bullish HA  ▓=Bearish HA  │=Wick');

  return lines.join('\n');
}

// ─── Exported Tool Functions ──────────────────────────────────────────────────

export async function getPriceActionChart({ count, style } = {}) {
  const limit = Math.min(count || 60, 200);
  const rawData = await getOhlcv({ count: limit });
  const bars = rawData.bars;
  const avgVol = bars.reduce((s, b) => s + b.volume, 0) / bars.length;

  const analyzed = bars.map((bar, i) => analyzeBar(bar, bars[i - 1] ?? null, avgVol));

  const useHA = style === 'heikin_ashi';
  const ascii = useHA
    ? buildHeikinAshiASCII(bars)
    : buildCandlestickASCII(bars, analyzed);

  // Compact bar summary for AI reference
  const barSummary = bars.map((bar, i) => {
    const a = analyzed[i];
    return {
      index: i,
      time: bar.time,
      open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      volume: bar.volume,
      direction: a.bullish ? 'Bull' : 'Bear',
      vs_high: a.vsHigh,
      vs_low: a.vsLow,
      pattern: a.pattern,
      vol: a.volumeChar,
    };
  });

  return {
    success: true,
    chart_type: useHA ? 'HeikinAshi' : 'PriceAction',
    bar_count: bars.length,
    period: { from: bars[0].time, to: bars[bars.length - 1].time },
    price_range: {
      high: Math.max(...bars.map(b => b.high)),
      low: Math.min(...bars.map(b => b.low)),
    },
    bars: barSummary,
    ascii_chart: ascii,
  };
}

export async function getIndividualBarChart({ bar_index, count } = {}) {
  const limit = Math.min(count || 50, 200);
  const rawData = await getOhlcv({ count: limit });
  const bars = rawData.bars;
  const idx = bar_index != null ? bar_index : bars.length - 1;

  if (idx < 0 || idx >= bars.length) {
    throw new Error(`Bar index ${idx} out of range (0–${bars.length - 1})`);
  }

  const bar = bars[idx];
  const avgVol = bars.reduce((s, b) => s + b.volume, 0) / bars.length;
  const info = analyzeBar(bar, bars[idx - 1] ?? null, avgVol);

  const move = bar.close - bar.open;
  const narrative = {
    open: `Opened at ${bar.open.toFixed(2)}`,
    high_move: `High ${bar.high.toFixed(2)} (+${(bar.high - bar.open).toFixed(2)} from open)`,
    low_move: `Low ${bar.low.toFixed(2)} (${(bar.low - bar.open).toFixed(2)} from open)`,
    close: `Closed at ${bar.close.toFixed(2)} (${move >= 0 ? '+' : ''}${move.toFixed(2)} net)`,
  };

  return {
    success: true,
    chart_type: 'IndividualBar',
    bar_index: idx,
    time: bar.time,
    ohlc: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
    volume: bar.volume,
    anatomy: {
      total_range: info.range,
      body_size: info.body,
      body_pct: info.bodyPct,
      upper_wick: info.upperWick,
      upper_wick_pct: info.upperPct,
      lower_wick: info.lowerWick,
      lower_wick_pct: info.lowerPct,
      direction: info.bullish ? 'Bullish' : 'Bearish',
    },
    structure: { vs_prev_high: info.vsHigh, vs_prev_low: info.vsLow },
    candlestick_pattern: info.pattern,
    volume_character: info.volumeChar,
    battle_narrative: narrative,
    ascii_diagram: buildBarAnatomyASCII(bar, info),
  };
}

export async function getVolumeProfileChart({ count, price_levels } = {}) {
  const limit = Math.min(count || 100, 500);
  const rawData = await getOhlcv({ count: limit });
  const bars = rawData.bars;

  const high = Math.max(...bars.map(b => b.high));
  const low = Math.min(...bars.map(b => b.low));
  const numLevels = Math.min(price_levels || 20, 40);
  const levelSize = (high - low) / numLevels || 1;

  const buckets = Array.from({ length: numLevels }, (_, i) => ({
    price: Math.round((low + (i + 0.5) * levelSize) * 100) / 100,
    price_low: low + i * levelSize,
    price_high: low + (i + 1) * levelSize,
    total_volume: 0,
    buying_volume: 0,
    selling_volume: 0,
    bar_count: 0,
    is_poc: false,
    is_vah: false,
    is_val: false,
  }));

  for (const bar of bars) {
    const bull = bar.close >= bar.open;
    const barRange = bar.high - bar.low || 1;
    for (const bucket of buckets) {
      const overlap = Math.min(bar.high, bucket.price_high) - Math.max(bar.low, bucket.price_low);
      if (overlap <= 0) continue;
      const vol = bar.volume * (overlap / barRange);
      bucket.total_volume += vol;
      if (bull) bucket.buying_volume += vol;
      else bucket.selling_volume += vol;
      bucket.bar_count++;
    }
  }

  for (const b of buckets) {
    b.total_volume = Math.round(b.total_volume);
    b.buying_volume = Math.round(b.buying_volume);
    b.selling_volume = Math.round(b.selling_volume);
    delete b.price_low;
    delete b.price_high;
  }

  const sorted = [...buckets].sort((a, b) => b.price - a.price);
  const poc = sorted.reduce((best, l) => l.total_volume > best.total_volume ? l : best, sorted[0]);
  poc.is_poc = true;

  const totalVol = sorted.reduce((s, l) => s + l.total_volume, 0);
  let vaVol = poc.total_volume;
  let vaHigh = poc.price, vaLow = poc.price;
  let up = sorted.indexOf(poc) - 1;
  let down = sorted.indexOf(poc) + 1;

  while (vaVol < totalVol * 0.7 && (up >= 0 || down < sorted.length)) {
    const upVol = up >= 0 ? sorted[up].total_volume : 0;
    const downVol = down < sorted.length ? sorted[down].total_volume : 0;
    if (upVol >= downVol && up >= 0) { vaVol += upVol; vaHigh = sorted[up].price; up--; }
    else if (down < sorted.length) { vaVol += downVol; vaLow = sorted[down].price; down++; }
    else break;
  }

  const vahLevel = sorted.find(l => l.price === vaHigh);
  const valLevel = sorted.find(l => l.price === vaLow);
  if (vahLevel) vahLevel.is_vah = true;
  if (valLevel) valLevel.is_val = true;

  return {
    success: true,
    chart_type: 'VolumeProfile',
    bar_count: bars.length,
    point_of_control: poc.price,
    value_area_high: vaHigh,
    value_area_low: vaLow,
    total_volume: totalVol,
    price_levels: sorted,
    ascii_chart: buildVolumeProfileASCII(sorted),
  };
}

// ─── Structure: Swings, Trend Lines, S/R, Al Brooks Signals — max 200 bars ───
function detectSwings(bars, lookback = 3) {
  const n = bars.length;
  const out = bars.map(() => ({ isHigh: false, isLow: false, vsHigh: '', vsLow: '' }));
  for (let i = lookback; i < n - lookback; i++) {
    const slice = bars.slice(i - lookback, i + lookback + 1);
    if (bars[i].high >= Math.max(...slice.map(b => b.high))) out[i].isHigh = true;
    if (bars[i].low  <= Math.min(...slice.map(b => b.low)))  out[i].isLow  = true;
  }
  let prevSH = null, prevSL = null;
  for (let i = 0; i < n; i++) {
    if (out[i].isHigh) {
      out[i].vsHigh = prevSH === null ? 'first' : bars[i].high > prevSH ? 'HH' : bars[i].high < prevSH ? 'LH' : '=';
      prevSH = bars[i].high;
    }
    if (out[i].isLow) {
      out[i].vsLow = prevSL === null ? 'first' : bars[i].low > prevSL ? 'HL' : bars[i].low < prevSL ? 'LL' : '=';
      prevSL = bars[i].low;
    }
  }
  return out;
}

// Trend lines: connect last 2 swing highs (resistance) and last 2 swing lows (support)
function computeTrendLines(bars, swings) {
  const highs = bars.map((b, i) => ({ i, p: b.high, s: swings[i] })).filter(x => x.s.isHigh && x.s.vsHigh !== 'first');
  const lows  = bars.map((b, i) => ({ i, p: b.low,  s: swings[i] })).filter(x => x.s.isLow  && x.s.vsLow  !== 'first');
  const lines = [];

  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    const slope = (b.p - a.p) / (b.i - a.i);
    lines.push({ role: 'Resistance', label: slope < 0 ? 'DownTrend' : 'UpTrend',
      from: { bar: a.i, price: a.p }, to: { bar: b.i, price: b.p }, slope: Math.round(slope * 10000) / 10000,
      current_price: Math.round((b.p + slope * (bars.length - 1 - b.i)) * 100) / 100 });
  }
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    const slope = (b.p - a.p) / (b.i - a.i);
    lines.push({ role: 'Support', label: slope > 0 ? 'UpTrend' : 'DownTrend',
      from: { bar: a.i, price: a.p }, to: { bar: b.i, price: b.p }, slope: Math.round(slope * 10000) / 10000,
      current_price: Math.round((b.p + slope * (bars.length - 1 - b.i)) * 100) / 100 });
  }
  return lines;
}

function computeBrooksSignals(bars) { // port: Al Brooks H1 L1 Signal Bars v2.3
  const LB=4,MIN=2,STR=0.16,sigs=new Array(bars.length).fill(null);
  let bL=-99,uL=-99,bSL=-99,lSL=-99,bCnt=0,lCnt=0,bHi=null,lLo=null;
  for (let i=2;i<bars.length;i++) {
    const b=bars[i],p=bars[i-1],rng=(b.high-b.low)||1e-4;
    if(b.close<b.open)bL=i; if(b.close>b.open)uL=i;
    let mB=0,cB=0,mU=0,cU=0;for(let k=1;k<=LB&&i-k>=0;k++){const q=bars[i-k];q.close<q.open?(cB++,mB=Math.max(mB,cB)):(cB=0);q.close>q.open?(cU++,mU=Math.max(mU,cU)):(cU=0);}
    if(b.close>b.open&&(b.high-b.close)<rng*STR&&b.close>p.high&&mB>=MIN&&(i-bL)<=LB&&bSL<bL){bCnt=(bHi===null||b.high>=bHi)?bCnt===0?1:bCnt+1:1;bHi=b.high;bSL=i;sigs[i]=`H${bCnt}`;}
    else if(b.close<b.open&&(b.close-b.low)<rng*STR&&b.close<p.low&&mU>=MIN&&(i-uL)<=LB&&lSL<uL){lCnt=(lLo===null||b.low<=lLo)?lCnt===0?1:lCnt+1:1;lLo=b.low;lSL=i;sigs[i]=`L${lCnt}`;}
  }
  return sigs;
}

function buildStructureASCII(bars, swings, signals, rows = 20) {
  if (bars.length === 0) return '';
  const high = Math.max(...bars.map(b => b.high));
  const low  = Math.min(...bars.map(b => b.low));
  const pr   = high - low || 1;
  const toRow = p => Math.min(rows - 1, Math.max(0, Math.round(((high - p) / pr) * (rows - 1))));
  // Swing markers in dedicated rows above/below chart — no inline collision with candles
  const grid   = Array.from({ length: rows }, () => new Array(bars.length * 2).fill(' '));
  const hiMark = new Array(bars.length * 2).fill(' '); // H=HH h=LH above chart
  const loMark = new Array(bars.length * 2).fill(' '); // L=LL l=HL below axis
  const sigRow = new Array(bars.length * 2).fill(' '); // Brooks letter
  const numRow = new Array(bars.length * 2).fill(' '); // Brooks number
  for (let bi = 0; bi < bars.length; bi++) {
    const b = bars[bi], col = bi * 2;
    const bull = b.close >= b.open;
    const bodyTop = Math.min(toRow(b.open), toRow(b.close));
    const bodyBot = Math.max(toRow(b.open), toRow(b.close));
    for (let r = toRow(b.high); r <= toRow(b.low); r++)
      grid[r][col] = (r >= bodyTop && r <= bodyBot) ? (bull ? '█' : '▓') : '│';
    if (swings[bi].isHigh) hiMark[col] = swings[bi].vsHigh === 'HH' ? 'H' : 'h';
    if (swings[bi].isLow)  loMark[col] = swings[bi].vsLow  === 'LL' ? 'L' : 'l';
    if (signals[bi]) { sigRow[col] = signals[bi][0]; numRow[col] = signals[bi][1] || ' '; }
  }
  const lw = 10, pad = ' '.repeat(lw + 3);
  const lines = [`${pad}${hiMark.join('').trimEnd()}`];
  for (let r = 0; r < rows; r++) {
    const price = high - (r / (rows - 1)) * pr;
    lines.push(`${yTick(price, pr, rows, lw)} ┤ ${grid[r].join('').trimEnd()}`);
  }
  lines.push(`${' '.repeat(lw)} └${'─'.repeat(bars.length * 2 + 2)}`);
  lines.push(`${pad}${loMark.join('').trimEnd()}`);
  lines.push(`${pad}${sigRow.join('').trimEnd()}`);
  lines.push(`${pad}${numRow.join('').trimEnd()}`);
  lines.push('H=HH  h=LH  L=LL  l=HL  H1/H2=Bull signal  L1/L2=Bear signal  █=Bull ▓=Bear');
  return lines.join('\n');
}

export async function getStructureChart({ count, lookback } = {}) {
  const limit = Math.min(count || 80, 200);
  const rawData = await getOhlcv({ count: limit });
  const bars = rawData.bars;
  const lb = Math.min(lookback || 3, 5);

  const swings  = detectSwings(bars, lb);
  const trendLines = computeTrendLines(bars, swings);
  const signals = computeBrooksSignals(bars);

  // S/R: last 3 confirmed swing highs = resistance, last 3 swing lows = support
  const resistance = bars.map((b, i) => ({ price: b.high, bar: i, label: swings[i].vsHigh }))
    .filter(x => x.label === 'HH' || x.label === 'LH').slice(-3).reverse();
  const support = bars.map((b, i) => ({ price: b.low, bar: i, label: swings[i].vsLow }))
    .filter(x => x.label === 'HL' || x.label === 'LL').slice(-3).reverse();

  // Recent swing summary
  const recentSwings = bars.map((b, i) => {
    const s = swings[i];
    if (!s.isHigh && !s.isLow) return null;
    return { bar: i, time: b.time, swing_high: s.isHigh ? b.high : null, vs_high: s.vsHigh || null,
             swing_low: s.isLow ? b.low : null, vs_low: s.vsLow || null };
  }).filter(Boolean).slice(-8);

  // Recent Brooks signals
  const recentSignals = signals.map((sig, i) => sig ? { bar: i, time: bars[i].time, signal: sig,
    price: sig.startsWith('H') ? bars[i].high : bars[i].low } : null).filter(Boolean).slice(-6);

  return {
    success: true,
    chart_type: 'Structure',
    bar_count: bars.length,
    lookback: lb,
    trend_lines: trendLines,
    resistance,
    support,
    recent_swings: recentSwings,
    brooks_signals: recentSignals,
    ascii_chart: buildStructureASCII(bars, swings, signals),
  };
}
