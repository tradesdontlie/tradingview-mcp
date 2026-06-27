/**
 * Trading agent analysis engine.
 * Single CDP evaluate call that computes regime + all signals.
 *
 * Regime detection: ADX14 — trending (> 25) vs ranging (≤ 25)
 * Ranging signals:
 *   LIQUIDITY_SWEEP_HIGH — wick above 20-bar swing high, last completed bar closed back below
 *   LIQUIDITY_SWEEP_LOW  — wick below 20-bar swing low,  last completed bar closed back above
 *   VWAP_UPPER2          — current bar touching VWAP +2SD (intraday only)
 *   VWAP_LOWER2          — current bar touching VWAP -2SD (intraday only)
 * Trending signals:
 *   EMA9_TOUCH           — current bar's range includes EMA9 (pullback entry)
 */
import { evaluate } from '../connection.js';

const ANALYSIS_JS = String.raw`
(function() {
  // ── Wilder RMA (used by ADX) ──
  function rma(arr, period) {
    if (arr.length < period) return null;
    var val = 0;
    for (var i = 0; i < period; i++) val += arr[i];
    val /= period;
    for (var i = period; i < arr.length; i++) val = (val * (period - 1) + arr[i]) / period;
    return val;
  }

  // ── EMA ──
  function ema(arr, period) {
    if (arr.length < period) return null;
    var k = 2 / (period + 1);
    var val = 0;
    for (var i = 0; i < period; i++) val += arr[i];
    val /= period;
    for (var i = period; i < arr.length; i++) val = arr[i] * k + val * (1 - k);
    return val;
  }

  // ── ADX14 ──
  function adx14(bars) {
    var period = 14;
    if (bars.length < period * 2 + 1) return null;
    var trs = [], pdms = [], ndms = [];
    for (var i = 1; i < bars.length; i++) {
      var hi = bars[i].high, lo = bars[i].low;
      var ph = bars[i-1].high, pl = bars[i-1].low, pc = bars[i-1].close;
      trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
      var upMove = hi - ph, downMove = pl - lo;
      pdms.push(upMove > downMove && upMove > 0 ? upMove : 0);
      ndms.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }
    var sTR = rma(trs, period), sPDM = rma(pdms, period), sNDM = rma(ndms, period);
    if (!sTR || sTR === 0) return null;
    // build DX series using progressive RMA
    var dxArr = [];
    var trRun = 0, pdRun = 0, ndRun = 0;
    for (var i = 0; i < trs.length; i++) {
      if (i < period) {
        trRun += trs[i]; pdRun += pdms[i]; ndRun += ndms[i];
        if (i === period - 1) { trRun /= period; pdRun /= period; ndRun /= period; }
      } else {
        trRun = (trRun * (period - 1) + trs[i]) / period;
        pdRun = (pdRun * (period - 1) + pdms[i]) / period;
        ndRun = (ndRun * (period - 1) + ndms[i]) / period;
        if (trRun === 0) { dxArr.push(0); continue; }
        var pdi = 100 * pdRun / trRun, ndi = 100 * ndRun / trRun;
        var s = pdi + ndi;
        dxArr.push(s === 0 ? 0 : 100 * Math.abs(pdi - ndi) / s);
      }
    }
    if (dxArr.length < period) return null;
    return Math.round(rma(dxArr, period) * 100) / 100;
  }

  // ── VWAP + 2SD (session-aware, intraday only) ──
  function vwapBands(bars, resolution) {
    // Skip for daily+ timeframes
    var res = parseInt(resolution, 10);
    if (!res || res >= 1440) return null;
    // Find session start: last bar with a different calendar day
    var last = bars[bars.length - 1];
    var lastDay = Math.floor(last.time / 86400);
    var sessionStart = 0;
    for (var i = bars.length - 1; i >= 0; i--) {
      if (Math.floor(bars[i].time / 86400) < lastDay) { sessionStart = i + 1; break; }
    }
    var sb = bars.slice(sessionStart);
    if (sb.length < 2) return null;
    // cumulative VWAP
    var cumTPV = 0, cumVol = 0;
    for (var i = 0; i < sb.length; i++) {
      var tp = (sb[i].high + sb[i].low + sb[i].close) / 3;
      cumTPV += tp * sb[i].volume; cumVol += sb[i].volume;
    }
    if (cumVol === 0) return null;
    var vwap = cumTPV / cumVol;
    // variance weighted by volume
    var variance = 0, cumV2 = 0, cumTP2 = 0;
    for (var i = 0; i < sb.length; i++) {
      var tp = (sb[i].high + sb[i].low + sb[i].close) / 3;
      cumV2 += sb[i].volume; cumTP2 += tp * sb[i].volume;
      var vwapHere = cumTP2 / cumV2;
      variance += sb[i].volume * (tp - vwapHere) * (tp - vwapHere);
    }
    var sd = cumVol > 0 ? Math.sqrt(variance / cumVol) : 0;
    return {
      vwap:   Math.round(vwap * 100) / 100,
      upper2: Math.round((vwap + 2 * sd) * 100) / 100,
      lower2: Math.round((vwap - 2 * sd) * 100) / 100,
      sd:     Math.round(sd * 100) / 100,
      session_bars: sb.length,
    };
  }

  // ── Pull bars ──
  var api = window.TradingViewApi._activeChartWidgetWV.value();
  var chart = api._chartWidget;
  var model = chart.model();
  var barsObj = model.mainSeries().bars();
  if (!barsObj || typeof barsObj.lastIndex !== 'function') return { error: 'No bars available' };

  var end = barsObj.lastIndex();
  var start = Math.max(barsObj.firstIndex(), end - 150);
  var bars = [];
  for (var i = start; i <= end; i++) {
    var v = barsObj.valueAt(i);
    if (v) bars.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
  }
  if (bars.length < 30) return { error: 'Not enough bars (' + bars.length + ')' };

  var resolution = api.resolution();
  var symbol = api.symbol();
  var closes = bars.map(function(b){ return b.close; });

  // Current forming bar + last completed bar
  var cur = bars[bars.length - 1];
  var prev = bars[bars.length - 2];

  // ── Indicators ──
  var adxVal = adx14(bars);
  var regime = adxVal === null ? 'unknown' : (adxVal > 25 ? 'trending' : 'ranging');

  var ema9Val = ema(closes, 9);
  var vwapData = vwapBands(bars, resolution);

  // Swing high/low over last 20 COMPLETED bars (exclude current forming bar)
  var lookback = bars.slice(-22, -1);
  var swingHigh = -Infinity, swingLow = Infinity;
  for (var i = 0; i < lookback.length; i++) {
    if (lookback[i].high > swingHigh) swingHigh = lookback[i].high;
    if (lookback[i].low  < swingLow)  swingLow  = lookback[i].low;
  }
  swingHigh = Math.round(swingHigh * 100) / 100;
  swingLow  = Math.round(swingLow  * 100) / 100;

  // ── Signals ──
  var signals = [];

  if (regime === 'ranging') {
    // Liquidity sweeps — check prev COMPLETED bar vs swing levels of bars before it
    var prevLookback = bars.slice(-23, -2);
    if (prevLookback.length >= 10) {
      var ph = -Infinity, pl = Infinity;
      for (var i = 0; i < prevLookback.length; i++) {
        if (prevLookback[i].high > ph) ph = prevLookback[i].high;
        if (prevLookback[i].low  < pl) pl = prevLookback[i].low;
      }
      ph = Math.round(ph * 100) / 100;
      pl = Math.round(pl * 100) / 100;
      // Buy-side sweep: prev bar wicked above swing high but closed below → short bias
      if (prev.high > ph && prev.close < ph) {
        signals.push({
          type: 'LIQUIDITY_SWEEP_HIGH',
          bias: 'SHORT',
          desc: 'Swept buy-side liq above ' + ph + ', closed back below',
          bar_time: prev.time,
          entry: prev.close,
          level: ph,
        });
      }
      // Sell-side sweep: prev bar wicked below swing low but closed above → long bias
      if (prev.low < pl && prev.close > pl) {
        signals.push({
          type: 'LIQUIDITY_SWEEP_LOW',
          bias: 'LONG',
          desc: 'Swept sell-side liq below ' + pl + ', closed back above',
          bar_time: prev.time,
          entry: prev.close,
          level: pl,
        });
      }
    }
    // VWAP bands — live current bar touch
    if (vwapData) {
      if (cur.high >= vwapData.upper2 && cur.low <= vwapData.upper2) {
        signals.push({
          type: 'VWAP_UPPER2',
          bias: 'SHORT',
          desc: 'Price touching VWAP +2SD (' + vwapData.upper2 + ')',
          bar_time: cur.time,
          entry: cur.close,
          level: vwapData.upper2,
        });
      }
      if (cur.high >= vwapData.lower2 && cur.low <= vwapData.lower2) {
        signals.push({
          type: 'VWAP_LOWER2',
          bias: 'LONG',
          desc: 'Price touching VWAP -2SD (' + vwapData.lower2 + ')',
          bar_time: cur.time,
          entry: cur.close,
          level: vwapData.lower2,
        });
      }
    }
  }

  if (regime === 'trending') {
    // EMA9 touch — live current bar
    if (ema9Val !== null && cur.low <= ema9Val && cur.high >= ema9Val) {
      var above = prev.close > ema9Val;
      signals.push({
        type: 'EMA9_TOUCH',
        bias: above ? 'LONG' : 'SHORT',
        desc: 'Price pulling back to EMA9 (' + Math.round(ema9Val * 100) / 100 + ')',
        bar_time: cur.time,
        entry: cur.close,
        level: Math.round(ema9Val * 100) / 100,
      });
    }
  }

  return {
    symbol:      symbol,
    resolution:  resolution,
    ts:          Date.now(),
    bar_time:    cur.time,
    close:       cur.close,
    high:        cur.high,
    low:         cur.low,
    adx:         adxVal,
    regime:      regime,
    ema9:        ema9Val !== null ? Math.round(ema9Val * 100) / 100 : null,
    vwap:        vwapData,
    swing_high:  swingHigh,
    swing_low:   swingLow,
    signals:     signals,
    bar_count:   bars.length,
  };
})()
`;

export async function analyzeChart() {
  return evaluate(ANALYSIS_JS);
}
