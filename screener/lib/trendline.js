/**
 * Downtrend-line break detection.
 *
 * A downtrend line is fit through the last two (or more) descending pivot
 * highs. A "break" is a close above the line's projected value on the
 * current bar. "Confirmed uptrend" additionally requires the market to have
 * printed at least one higher-high and one higher-low after the break —
 * a single breakout candle alone can be a fakeout.
 */
export function detectDowntrendBreak(bars, pivots) {
  const highs = pivots.filter(p => p.type === 'high');
  if (highs.length < 2) return null;

  // Anchor the line on the MOST RECENT pivot high, then walk backward for the
  // nearest earlier high that's still above it — i.e. the current, still-
  // intact descending line an analyst would actually draw right now. (The
  // previous version tried every pair in a nested loop and just kept
  // whichever happened to be checked last, which wasn't a deliberate choice
  // of "most relevant descending pair" — it was an accident of loop order.)
  const recentHighs = highs.slice(-5);
  const b = recentHighs[recentHighs.length - 1];
  let a = null;
  for (let i = recentHighs.length - 2; i >= 0; i--) {
    if (recentHighs[i].price > b.price) { a = recentHighs[i]; break; }
  }
  if (!a) return null;
  const line = { x1: a.index, y1: a.price, x2: b.index, y2: b.price };

  const slope = (line.y2 - line.y1) / (line.x2 - line.x1);
  const lastIndex = bars.length - 1;
  const lineValueAtLast = line.y1 + slope * (lastIndex - line.x1);
  const lastClose = bars[lastIndex].close;

  const brokenOut = lastClose > lineValueAtLast;
  if (!brokenOut) return null;

  const lastBar = bars[lastIndex];
  if (!(lastBar.close > lastBar.open)) return null; // breakout day itself must close green

  // Confirm uptrend structure after the line's second anchor point. This used
  // to be returned as a `confirmed_uptrend` boolean that the caller (scan.js)
  // checked before accepting the match — functionally equivalent, but it
  // meant the raw function could hand back "matched: true" for an
  // unconfirmed breakout to anyone who called it directly. Rejecting here
  // makes the guarantee part of the function's own contract.
  const afterBreak = pivots.filter(p => p.index > line.x2);
  const higherHighs = afterBreak.filter(p => p.type === 'high' && p.price > line.y2);
  const lowsAfter = afterBreak.filter(p => p.type === 'low');
  const priorLow = pivots.filter(p => p.type === 'low' && p.index <= line.x2).slice(-1)[0];
  const higherLowConfirmed = priorLow && lowsAfter.some(p => p.price > priorLow.price);
  if (higherHighs.length < 1 || !higherLowConfirmed) return null;

  return {
    matched: true,
    line_start: { index: line.x1, price: line.y1 },
    line_end: { index: line.x2, price: line.y2 },
    line_value_now: Math.round(lineValueAtLast * 1e6) / 1e6,
    breakout_close: lastClose,
  };
}
