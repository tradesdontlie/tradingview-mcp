// Canvas-based candlestick replay + strategy overlay. No external chart
// library — self-contained, matches this repo's existing vanilla-JS style
// (public/dashboard.js has no chart dependency either).
//
// Data source right now is REPLAY data, pre-exported to JSON by
// ml/serve/export_strategy_viz.py (see that script's docstring for the
// planned live-data swap point). This file only ever reads
// data/{symbol}_bars.json and data/{symbol}_{strategy}_events.json — when
// the live source replaces the replay export, only those two payload
// shapes need to keep matching, nothing here changes.

const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');

const state = {
  symbol: 'MGC1!',
  strategy: 'trend_breakout',
  bars: [],
  timeIndex: new Map(), // time -> bar index
  events: { trades: [], levels: [] },
  cursor: 0,
  windowSize: 180,
  playing: false,
  speed: 5,
  rafId: null,
  lastTick: 0,
};

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}
window.addEventListener('resize', resizeCanvas);

function stem(symbol) {
  return symbol.replace(/[:!]/g, '');
}

async function loadData() {
  stopPlayback();
  const s = stem(state.symbol);
  const [bars, events] = await Promise.all([
    fetch(`data/${s}_bars.json`).then(r => { if (!r.ok) throw new Error('no bars'); return r.json(); }),
    fetch(`data/${s}_${state.strategy}_events.json`).then(r => r.ok ? r.json() : { trades: [], levels: [] }),
  ]);
  state.bars = bars;
  state.events = events;
  state.timeIndex = new Map(bars.map((b, i) => [b.time, i]));
  state.cursor = Math.min(state.windowSize, bars.length);

  const scrub = document.getElementById('scrub');
  scrub.max = String(Math.max(0, bars.length - 1));
  scrub.value = String(state.cursor);

  render();
  updateStats();
}

// nearest bar index at-or-after a given unix-seconds time (bars can have
// gaps — weekends, session closes — so exact-match lookups aren't safe)
function indexAtOrAfter(time) {
  if (state.timeIndex.has(time)) return state.timeIndex.get(time);
  let lo = 0, hi = state.bars.length - 1, ans = state.bars.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.bars[mid].time >= time) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
  }
  return ans;
}

function render() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  if (!state.bars.length) return;

  const start = Math.max(0, state.cursor - state.windowSize);
  const end = Math.max(start + 1, state.cursor);
  const visible = state.bars.slice(start, end);
  if (!visible.length) return;

  let lo = Infinity, hi = -Infinity;
  for (const b of visible) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
  const pad = (hi - lo) * 0.08 || 1;
  const yMin = lo - pad, yMax = hi + pad;

  const priceColW = 62;
  const plotW = w - priceColW;
  const barW = plotW / visible.length;
  const xAt = i => i * barW;
  const yAt = price => h - ((price - yMin) / (yMax - yMin)) * h;

  // gridlines + price axis
  ctx.strokeStyle = '#1c2128';
  ctx.fillStyle = '#6e7681';
  ctx.font = '11px monospace';
  ctx.textBaseline = 'middle';
  const gridLines = 6;
  for (let g = 0; g <= gridLines; g++) {
    const price = yMin + (yMax - yMin) * (g / gridLines);
    const y = yAt(price);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillText(price.toFixed(2), plotW + 6, y);
  }

  // levels (dotted horizontal segments, clipped to their [start_time, end_time])
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = '#58a6ff';
  ctx.fillStyle = '#58a6ff';
  ctx.font = '10px monospace';
  const drawnLabels = new Set();
  for (const lvl of state.events.levels || []) {
    const segStartIdx = Math.max(start, indexAtOrAfter(lvl.start_time));
    const segEndIdx = Math.min(end - 1, indexAtOrAfter(lvl.end_time));
    if (segEndIdx < start || segStartIdx > end - 1 || segStartIdx > segEndIdx) continue;
    const y = yAt(lvl.price);
    const x0 = xAt(segStartIdx - start), x1 = xAt(segEndIdx - start) + barW;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    const key = lvl.type + '@' + lvl.price.toFixed(2) + '@' + segEndIdx;
    if (!drawnLabels.has(key)) {
      drawnLabels.add(key);
      ctx.fillText(`${lvl.type} ${lvl.price.toFixed(2)}`, x0 + 2, y - 8);
    }
  }
  ctx.setLineDash([]);

  // candles
  for (let i = 0; i < visible.length; i++) {
    const b = visible[i];
    const cx = xAt(i) + barW / 2;
    const up = b.close >= b.open;
    ctx.strokeStyle = ctx.fillStyle = up ? '#3fb950' : '#f85149';
    ctx.beginPath(); ctx.moveTo(cx, yAt(b.high)); ctx.lineTo(cx, yAt(b.low)); ctx.stroke();
    const bodyTop = yAt(Math.max(b.open, b.close));
    const bodyBot = yAt(Math.min(b.open, b.close));
    ctx.fillRect(xAt(i) + barW * 0.18, bodyTop, Math.max(1, barW * 0.64), Math.max(1, bodyBot - bodyTop));
  }

  // trades: entry marker, exit marker, connecting line
  for (const t of state.events.trades || []) {
    if (t.entry_time == null) continue;
    const entryIdx = indexAtOrAfter(t.entry_time);
    if (entryIdx < start || entryIdx > end - 1) continue;
    const isLong = t.direction === 'long';
    const win = (t.pnl_points ?? 0) > 0;
    const color = t.status === 'OPEN_AT_BACKTEST_END' ? '#e3b341' : (win ? '#3fb950' : '#f85149');
    const ex = xAt(entryIdx - start) + barW / 2;
    const ey = yAt(t.entry_price);

    ctx.fillStyle = color;
    ctx.strokeStyle = '#0e1117';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (isLong) { ctx.moveTo(ex, ey + 9); ctx.lineTo(ex - 6, ey + 18); ctx.lineTo(ex + 6, ey + 18); }
    else { ctx.moveTo(ex, ey - 9); ctx.lineTo(ex - 6, ey - 18); ctx.lineTo(ex + 6, ey - 18); }
    ctx.closePath(); ctx.fill(); ctx.stroke();

    if (t.exit_time != null && t.exit_time <= state.bars[end - 1].time) {
      const exitIdx = Math.min(end - 1, indexAtOrAfter(t.exit_time));
      const xx = xAt(exitIdx - start) + barW / 2;
      const xy = yAt(t.exit_price);
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(xx, xy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(xx - 5, xy - 5); ctx.lineTo(xx + 5, xy + 5);
      ctx.moveTo(xx + 5, xy - 5); ctx.lineTo(xx - 5, xy + 5);
      ctx.stroke();
    }
  }

  // time axis (a handful of labels across the visible window)
  ctx.fillStyle = '#6e7681';
  ctx.textBaseline = 'top';
  const labelEvery = Math.max(1, Math.floor(visible.length / 6));
  for (let i = 0; i < visible.length; i += labelEvery) {
    const label = ET_FMT.format(new Date(visible[i].time * 1000));
    ctx.fillText(label, xAt(i), h - 14);
  }

  document.getElementById('clock').textContent = ET_FMT.format(new Date(visible[visible.length - 1].time * 1000)) + ' ET';
}

function updateStats() {
  if (!state.bars.length) return;
  const nowTime = state.bars[Math.min(state.cursor, state.bars.length) - 1].time;
  const completed = (state.events.trades || []).filter(t => t.exit_time != null && t.exit_time <= nowTime);
  const open = (state.events.trades || []).find(t => t.entry_time != null && t.entry_time <= nowTime
    && (t.exit_time == null || t.exit_time > nowTime));

  document.getElementById('statN').textContent = String(completed.length);
  if (completed.length) {
    const wins = completed.filter(t => (t.pnl_points ?? 0) > 0);
    const grossProfit = completed.filter(t => (t.pnl_points ?? 0) > 0).reduce((s, t) => s + t.pnl_points, 0);
    const grossLoss = -completed.filter(t => (t.pnl_points ?? 0) < 0).reduce((s, t) => s + t.pnl_points, 0);
    const totalPoints = completed.reduce((s, t) => s + (t.pnl_points ?? 0), 0);
    document.getElementById('statWin').textContent = (100 * wins.length / completed.length).toFixed(1) + '%';
    document.getElementById('statPF').textContent = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞';
    document.getElementById('statTotal').textContent = totalPoints.toFixed(1) + ' pt';
  } else {
    document.getElementById('statWin').textContent = '—';
    document.getElementById('statPF').textContent = '—';
    document.getElementById('statTotal').textContent = '—';
  }
  document.getElementById('statPos').textContent = open ? `${open.direction.toUpperCase()} @ ${open.entry_price.toFixed(2)}` : 'flat';
}

function stepPlayback(ts) {
  if (!state.playing) return;
  if (ts - state.lastTick > 66) { // ~15fps tick
    state.lastTick = ts;
    state.cursor = Math.min(state.bars.length, state.cursor + state.speed);
    document.getElementById('scrub').value = String(state.cursor);
    render();
    updateStats();
    if (state.cursor >= state.bars.length) { stopPlayback(); }
  }
  if (state.playing) state.rafId = requestAnimationFrame(stepPlayback);
}

function startPlayback() {
  state.playing = true;
  document.getElementById('playPause').textContent = '⏸ Pause';
  state.lastTick = 0;
  state.rafId = requestAnimationFrame(stepPlayback);
}

function stopPlayback() {
  state.playing = false;
  document.getElementById('playPause').textContent = '▶ Play';
  if (state.rafId) cancelAnimationFrame(state.rafId);
}

document.getElementById('playPause').addEventListener('click', () => {
  if (state.playing) stopPlayback(); else startPlayback();
});
document.getElementById('speed').addEventListener('change', e => { state.speed = Number(e.target.value); });
document.getElementById('scrub').addEventListener('input', e => {
  stopPlayback();
  state.cursor = Number(e.target.value);
  render();
  updateStats();
});
document.getElementById('symbol').addEventListener('change', e => { state.symbol = e.target.value; loadData(); });
document.getElementById('strategy').addEventListener('change', e => { state.strategy = e.target.value; loadData(); });

resizeCanvas();
loadData();
