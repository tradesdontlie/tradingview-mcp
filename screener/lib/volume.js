import { avgVolume, sma } from './zigzag.js';

/**
 * Breakout-pullback-retest-bounce: price breaks above a known resistance,
 * pulls back for several days on profit-taking (red candles), the pullback
 * comes back down to actually retest the broken level (now support), and
 * today closes green confirming the bounce held. This is a materially
 * stronger confirmation than "just crossed above with volume today" — it
 * proves the old resistance has flipped to real support rather than price
 * merely poking above it once.
 */
export function detectBreakoutWithVolume(bars, srZones, opts = {}) {
  const { maxLookback = 30, minPullbackDays = 2, retestTolerancePct = 0.02, volMultiple = 1.3 } = opts;
  const n = bars.length;
  const today = bars[n - 1];
  if (!(today.close > today.open)) return null; // today must be the bounce candle, closing green

  const baseAvgVol = avgVolume(bars.slice(0, -1), 20);
  const resistances = srZones.filter(z => z.type === 'resistance');

  for (const res of resistances) {
    // 1. Find the most recent bar (within the lookback window, excluding
    //    today) whose close crossed from at/below the resistance to above it.
    let breakoutIdx = -1;
    const start = Math.max(1, n - 1 - maxLookback);
    for (let i = start; i < n - 1; i++) {
      if (bars[i - 1].close <= res.price && bars[i].close > res.price) breakoutIdx = i;
    }
    if (breakoutIdx === -1) continue; // no breakout of this level found in the window

    // 2. Several days of pullback (red candles) must follow the breakout —
    //    profit-taking, not an uninterrupted run.
    const afterBreakout = bars.slice(breakoutIdx + 1, n - 1);
    if (afterBreakout.length < minPullbackDays) continue;
    const redDays = afterBreakout.filter(b => b.close < b.open).length;
    if (redDays < minPullbackDays) continue;

    // 3. The pullback must actually come back down to retest the broken
    //    level — not just drift sideways well above it.
    const pullbackLow = Math.min(...afterBreakout.map(b => b.low), today.low);
    if (Math.abs(pullbackLow - res.price) / res.price > retestTolerancePct) continue;

    // 4. Today's bounce must hold above the resistance-turned-support, with
    //    at least some volume pickup confirming buyers stepped back in.
    if (today.close <= res.price) continue;
    if (baseAvgVol > 0 && today.volume < baseAvgVol * volMultiple) continue;

    return {
      matched: true,
      pattern: 'breakout_resistance_with_volume',
      resistance_level: Math.round(res.price * 1e6) / 1e6,
      pullback_days: redDays,
      retest_low: Math.round(pullbackLow * 1e6) / 1e6,
      breakout_volume: today.volume,
      avg_volume_20: Math.round(baseAvgVol),
      volume_ratio: baseAvgVol > 0 ? Math.round((today.volume / baseAvgVol) * 100) / 100 : null,
    };
  }
  return null;
}

/**
 * Volume spike on a green (bullish) candle, WITHIN an uptrend context.
 * A volume+green spike on its own has no idea where it's happening — the
 * same candle inside a downtrend is just as easily a dead-cat bounce as it
 * is real accumulation. Requiring price above its SMA20 rules out flagging
 * spikes that show up while the stock is still trending down.
 */
export function detectVolumeSpikeGreenCandle(bars, volMultiple = 2) {
  const last = bars[bars.length - 1];
  const baseAvgVol = avgVolume(bars.slice(0, -1), 20);
  if (baseAvgVol <= 0) return null;
  const isGreen = last.close > last.open;
  const isSpike = last.volume >= baseAvgVol * volMultiple;
  if (!isGreen || !isSpike) return null;

  const sma20 = sma(bars, 20);
  if (!sma20 || last.close <= sma20) return null; // must be trading above its own short-term average, not bouncing inside a downtrend

  return {
    matched: true,
    pattern: 'volume_spike_green_candle',
    volume: last.volume,
    avg_volume_20: Math.round(baseAvgVol),
    volume_ratio: Math.round((last.volume / baseAvgVol) * 100) / 100,
    sma20: Math.round(sma20 * 1e6) / 1e6,
  };
}

/** General trend-following filter: price above both SMA50 and SMA200, with a higher-high/higher-low pivot structure. */
export function detectConfirmedUptrend(bars, pivots) {
  const last = bars[bars.length - 1];
  const sma50 = sma(bars, 50);
  // Only compute SMA200 when there's actually 200 bars of history — a stock
  // with, say, 80 bars (recent IPO) would otherwise get an SMA80 silently
  // mislabeled "sma200" in the report.
  const sma200 = bars.length >= 200 ? sma(bars, 200) : null;
  if (!sma50) return null;

  const aboveSma = last.close > sma50 && (sma200 == null || last.close > sma200);
  if (!aboveSma) return null;

  const highs = pivots.filter(p => p.type === 'high').slice(-3);
  const lows = pivots.filter(p => p.type === 'low').slice(-3);
  const higherHighs = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price;
  const higherLows = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price;
  if (!higherHighs || !higherLows) return null;

  return {
    matched: true,
    pattern: 'confirmed_uptrend',
    close: last.close,
    sma50: Math.round(sma50 * 1e6) / 1e6,
    sma200: sma200 ? Math.round(sma200 * 1e6) / 1e6 : null,
  };
}
