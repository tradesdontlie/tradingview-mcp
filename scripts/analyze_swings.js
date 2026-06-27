// One-off swing-pivot analyzer for the current chart's OHLCV.
// Reads JSON from stdin (output of `tv ohlcv --count N`) and prints
// significant swing highs and lows using a configurable left/right pivot width.

import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync(0, 'utf8'));
const bars = data.bars;
const PIVOT = 7; // bars on each side that must be lower/higher

const swingHighs = [];
const swingLows = [];

for (let i = PIVOT; i < bars.length - PIVOT; i++) {
  const { high, low, time, volume } = bars[i];
  let isHigh = true;
  let isLow = true;
  for (let j = i - PIVOT; j <= i + PIVOT; j++) {
    if (j === i) continue;
    if (bars[j].high > high) isHigh = false;
    if (bars[j].low < low) isLow = false;
  }
  const date = new Date(time * 1000).toISOString().slice(0, 10);
  if (isHigh) swingHighs.push({ date, price: high, volume });
  if (isLow) swingLows.push({ date, price: low, volume });
}

console.log('=== SWING HIGHS (7-bar pivots) ===');
for (const s of swingHighs) {
  console.log(`  ${s.date}  $${s.price.toFixed(2).padStart(8)}  vol=${s.volume.toFixed(0)}`);
}
console.log(`\n=== SWING LOWS (7-bar pivots) ===`);
for (const s of swingLows) {
  console.log(`  ${s.date}  $${s.price.toFixed(2).padStart(8)}  vol=${s.volume.toFixed(0)}`);
}

// Cluster swings within 2% tolerance to find multi-touch zones
function cluster(swings, tolPct = 0.02) {
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters = [];
  let cur = null;
  for (const s of sorted) {
    if (!cur || (s.price - cur.center) / cur.center > tolPct) {
      cur = { center: s.price, members: [s] };
      clusters.push(cur);
    } else {
      cur.members.push(s);
      cur.center = cur.members.reduce((a, b) => a + b.price, 0) / cur.members.length;
    }
  }
  return clusters.filter(c => c.members.length >= 2)
    .sort((a, b) => b.members.length - a.members.length);
}

console.log(`\n=== CLUSTERED HIGH ZONES (>=2 touches, within 2%) ===`);
for (const c of cluster(swingHighs)) {
  console.log(`  $${c.center.toFixed(2).padStart(8)}  (${c.members.length} touches: ${c.members.map(m => m.date).join(', ')})`);
}
console.log(`\n=== CLUSTERED LOW ZONES (>=2 touches, within 2%) ===`);
for (const c of cluster(swingLows)) {
  console.log(`  $${c.center.toFixed(2).padStart(8)}  (${c.members.length} touches: ${c.members.map(m => m.date).join(', ')})`);
}

// All-time extremes within the data window
const allHigh = bars.reduce((a, b) => b.high > a.high ? b : a);
const allLow = bars.reduce((a, b) => b.low < a.low ? b : a);
console.log(`\n=== EXTREMES ===`);
console.log(`  ATH within window: $${allHigh.high.toFixed(2)} on ${new Date(allHigh.time * 1000).toISOString().slice(0, 10)}`);
console.log(`  ATL within window: $${allLow.low.toFixed(2)} on ${new Date(allLow.time * 1000).toISOString().slice(0, 10)}`);
console.log(`  Current price (last close): $${bars[bars.length - 1].close.toFixed(2)}`);
