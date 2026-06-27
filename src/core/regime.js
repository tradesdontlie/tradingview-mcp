/**
 * Regime Analysis Engine
 * Four-layer classification: Structure → Price Action → Volume → Session
 * Returns structured data for all visible chart panes in one CDP call.
 */
import { evaluate } from '../connection.js';
import { ensureFreshBaselines, getWeeklyRatio } from './weeklyVolume.js';

export const REGIME_JS = String.raw`
(function() {

  // ════════════════════════════════════════════════════════════
  //  HELPERS
  // ════════════════════════════════════════════════════════════

  function rma(arr, period) {
    if (arr.length < period) return null;
    var v = 0;
    for (var i = 0; i < period; i++) v += arr[i];
    v /= period;
    for (var i = period; i < arr.length; i++) v = (v * (period - 1) + arr[i]) / period;
    return v;
  }

  function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce(function(a,b){return a+b;},0) / arr.length;
  }

  function r2(n) { return Math.round(n * 100) / 100; }

  // ════════════════════════════════════════════════════════════
  //  LAYER 1: STRUCTURE  (weight 40)
  //  Pivot detection → BOS / CHoCH → HH/HL or LH/LL sequence
  // ════════════════════════════════════════════════════════════

  function findPivots(bars, strength) {
    strength = strength || 3;
    var highs = [], lows = [];
    // exclude the last (strength) bars (unconfirmed)
    var end = bars.length - strength - 1;
    for (var i = strength; i <= end; i++) {
      var isH = true, isL = true;
      for (var j = 1; j <= strength; j++) {
        if (bars[i].high <= bars[i-j].high || bars[i].high <= bars[i+j].high) isH = false;
        if (bars[i].low  >= bars[i-j].low  || bars[i].low  >= bars[i+j].low ) isL = false;
      }
      if (isH) highs.push({ idx: i, price: bars[i].high, time: bars[i].time });
      if (isL) lows.push({  idx: i, price: bars[i].low,  time: bars[i].time });
    }
    return { highs: highs, lows: lows };
  }

  function analyzeStructure(bars, pivots) {
    var cur   = bars[bars.length - 1];
    var highs = pivots.highs;
    var lows  = pivots.lows;

    if (highs.length < 2 || lows.length < 2) {
      return { score: 0, bos: null, choch: false, priorTrend: 'neutral',
               lastSwingHigh: null, lastSwingLow: null, sequenceLabel: 'insufficient data' };
    }

    var lH = highs[highs.length - 1];   // most recent pivot high
    var pH = highs[highs.length - 2];   // previous pivot high
    var lL = lows[lows.length - 1];     // most recent pivot low
    var pL = lows[lows.length - 2];     // previous pivot low

    // Prior trend from last 2 pivot pairs
    var hhPattern = lH.price > pH.price; // higher high
    var hlPattern = lL.price > pL.price; // higher low
    var lhPattern = lH.price < pH.price; // lower high
    var llPattern = lL.price < pL.price; // lower low

    var priorTrend = 'neutral';
    if (hhPattern && hlPattern) priorTrend = 'up';
    else if (lhPattern && llPattern) priorTrend = 'down';

    // BOS: close breaks the last confirmed swing extreme
    var bosUp   = cur.close > lH.price;
    var bosDown = cur.close < lL.price;
    var bos = bosUp ? 'up' : (bosDown ? 'down' : null);

    // CHoCH: break AGAINST prior trend → character change
    var choch = (priorTrend === 'down' && bosUp) || (priorTrend === 'up' && bosDown);

    // Sequence label for display
    var seqLabel = priorTrend === 'up'   ? 'HH-HL  ↑' :
                   priorTrend === 'down' ? 'LH-LL  ↓' : 'Mixed';

    // Score
    var score = 0;
    if (bos && !choch)  score = 35;  // confirmed BOS in trend direction
    else if (choch)     score = 22;  // CHoCH = transition, partial credit
    else if (priorTrend !== 'neutral') score = 12;  // clear HH/HL or LH/LL without BOS
    // else score = 0 (no structure)

    return {
      score: score,
      bos: bos,
      choch: choch,
      priorTrend: priorTrend,
      lastSwingHigh: r2(lH.price),
      lastSwingLow:  r2(lL.price),
      sequenceLabel: seqLabel,
    };
  }

  // ════════════════════════════════════════════════════════════
  //  LAYER 2: PRICE ACTION  (weight 25 ATR + 15 body + 20 vwap = 60 → split)
  //  ATR ratio, candle body/wick ratio, VWAP deviation
  // ════════════════════════════════════════════════════════════

  function calcATR(bars) {
    var period = 14, baseLen = 20;
    if (bars.length < period + baseLen + 1) return null;
    var trs = [];
    for (var i = 1; i < bars.length; i++) {
      trs.push(Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i-1].close),
        Math.abs(bars[i].low  - bars[i-1].close)
      ));
    }
    var curATR  = mean(trs.slice(-period));
    var baseATR = mean(trs.slice(-(period + baseLen), -period));
    return { current: r2(curATR), baseline: r2(baseATR), ratio: r2(curATR / baseATR) };
  }

  function atrScore(ratio) {
    if (ratio === null) return 0;
    if (ratio > 1.5)  return 25;
    if (ratio > 1.3)  return 20;
    if (ratio > 1.1)  return 12;
    if (ratio > 0.9)  return 6;
    return 0;
  }

  function calcBodyRatio(bars, n) {
    var recent = bars.slice(-n);
    var ratios = recent.map(function(b) {
      var range = b.high - b.low;
      return range > 0 ? Math.abs(b.close - b.open) / range : 0.5;
    });
    return r2(mean(ratios));
  }

  function bodyScore(ratio) {
    if (ratio > 0.65) return 15;
    if (ratio > 0.50) return 10;
    if (ratio > 0.35) return 5;
    return 0;
  }

  function calcVWAP(bars, resolution) {
    var res = parseInt(resolution, 10);
    if (!res || res >= 1440) return null;   // daily+ → skip VWAP
    var lastDay = Math.floor(bars[bars.length-1].time / 86400);
    var si = 0;
    for (var i = bars.length - 1; i >= 0; i--) {
      if (Math.floor(bars[i].time / 86400) < lastDay) { si = i + 1; break; }
    }
    var sb = bars.slice(si);
    if (sb.length < 2) return null;
    var cumTPV = 0, cumV = 0, cumTPV2 = 0;
    for (var i = 0; i < sb.length; i++) {
      var tp = (sb[i].high + sb[i].low + sb[i].close) / 3;
      cumTPV  += tp * sb[i].volume;
      cumV    += sb[i].volume;
      cumTPV2 += tp * tp * sb[i].volume;
    }
    if (cumV === 0) return null;
    var vwap = cumTPV / cumV;
    var variance = Math.max(cumTPV2 / cumV - vwap * vwap, 0);
    var sd = Math.sqrt(variance);
    return { vwap: r2(vwap), upper2: r2(vwap + 2*sd), lower2: r2(vwap - 2*sd), sd: r2(sd) };
  }

  function vwapScore(devPct) {
    if (devPct === null) return 0;
    if (devPct > 0.8)  return 20;
    if (devPct > 0.5)  return 15;
    if (devPct > 0.3)  return 8;
    return 0;
  }

  // ════════════════════════════════════════════════════════════
  //  LAYER 3: VOLUME  (soft filter, weight 0 but shown in display)
  // ════════════════════════════════════════════════════════════

  function calcVolumeRatio(bars) {
    var period = 20;
    if (bars.length < period + 1) return null;
    var baseline = mean(bars.slice(-(period+1), -1).map(function(b){return b.volume;}));
    var cur = bars[bars.length-1].volume;
    return r2(baseline > 0 ? cur / baseline : 1);
  }

  // Approximate ET hour-of-day (not DST-adjusted; close enough for bucketing)
  function etHour(unixTs) {
    return ((unixTs % 86400) / 3600 + 24 - 4) % 24;
  }

  // NOTE: the weekly seasonal volume baseline is computed Node-side from
  // yfinance (see src/core/weeklyVolume.js), not here — the browser only
  // has whatever bars TradingView happens to have buffered in memory, which
  // isn't reliable enough for a trailing-week baseline. The browser just
  // reports the current bar's volume + ET hour bucket; Node.js does the lookup.

  // ════════════════════════════════════════════════════════════
  //  LAYER 4: SESSION  (prior bias)
  // ════════════════════════════════════════════════════════════

  function getSession(unixTs) {
    var h = etHour(unixTs);
    if (h >= 18 || h < 2)   return 'ASIA';
    if (h >= 2  && h < 8)   return 'LONDON';
    if (h >= 8  && h < 9.5) return 'PRE-NY';
    if (h >= 9.5 && h < 16) return 'NY';
    return 'OFF';
  }

  // Session bias applied to raw score (before threshold comparison)
  var SESSION_BIAS = { ASIA: -8, LONDON: 0, 'PRE-NY': 3, NY: 6, OFF: -5 };

  // ════════════════════════════════════════════════════════════
  //  CLASSIFICATION  (score 0-100 → regime)
  // ════════════════════════════════════════════════════════════

  function classify(rawScore, session) {
    var bias  = SESSION_BIAS[session] || 0;
    var score = Math.min(100, Math.max(0, rawScore + bias));
    var regime, confidence;
    if (score >= 62) {
      regime = 'TRENDING'; confidence = Math.round(40 + score * 0.6);
    } else if (score <= 35) {
      regime = 'RANGING'; confidence = Math.round(40 + (100 - score) * 0.6);
    } else {
      regime = 'TRANSITIONING'; confidence = Math.round(50 - Math.abs(score - 48));
    }
    return { regime: regime, rawScore: rawScore, adjustedScore: score,
             confidence: Math.min(97, confidence) };
  }

  // ════════════════════════════════════════════════════════════
  //  PER-PANE ANALYSIS
  // ════════════════════════════════════════════════════════════

  function analyzePane(chartWidget) {
    try {
      var model  = chartWidget.model();
      var ms     = model.mainSeries();
      var symbol = ms.symbol ? ms.symbol() : '?';
      var res    = ms.interval ? ms.interval() : '?';
      var barsObj = ms.bars();
      if (!barsObj || typeof barsObj.lastIndex !== 'function') return null;

      var end = barsObj.lastIndex();
      // Pull enough history to cover at least one full session for VWAP on fast
      // timeframes (200 bars = only 3.3hrs on a 1m chart, not enough for a full day).
      var resMin = parseInt(res, 10);
      var fetchLimit = (resMin && resMin < 1440)
        ? Math.min(1500, Math.ceil((24 * 60) / resMin) + 200)
        : 200;
      var start = Math.max(barsObj.firstIndex(), end - fetchLimit + 1);
      var bars = [];
      for (var i = start; i <= end; i++) {
        var v = barsObj.valueAt(i);
        if (v) bars.push({ time:v[0], open:v[1], high:v[2], low:v[3], close:v[4], volume:v[5]||0 });
      }
      if (bars.length < 40) return { symbol:symbol, error:'not enough bars ('+bars.length+')' };

      var cur = bars[bars.length - 1];

      // Layer 1: Structure
      var pivots = findPivots(bars, 3);
      var struct = analyzeStructure(bars, pivots);

      // Layer 2: Price action
      var atr    = calcATR(bars);
      var body   = calcBodyRatio(bars, 10);
      var vwapD  = calcVWAP(bars, res);
      var vwapDev = vwapD ? r2(Math.abs(cur.close - vwapD.vwap) / vwapD.vwap * 100) : null;

      // Layer 3: Volume (local 20-bar baseline; weekly baseline filled in Node-side)
      var volRatio   = calcVolumeRatio(bars);

      // Session
      var session = getSession(cur.time);

      // Raw score
      var rawScore = struct.score
        + atrScore(atr ? atr.ratio : null)
        + bodyScore(body)
        + vwapScore(vwapDev);

      var cls = classify(rawScore, session);

      // Trend direction (for TRENDING regime)
      var trendDir = null;
      if (cls.regime === 'TRENDING') {
        trendDir = struct.bos === 'up'   ? 'UP'   :
                   struct.bos === 'down' ? 'DOWN' :
                   struct.priorTrend === 'up' ? 'UP' : 'DOWN';
      }

      // Range boundaries (for RANGING)
      var rangeHigh = struct.lastSwingHigh;
      var rangeLow  = struct.lastSwingLow;

      // ── REVERSAL DETECTION ─────────────────────────────────────────────────
      var revScore = 0;
      var revTriggers = [];
      var revDir = null;

      // 1. CHoCH = structural reversal (strongest single signal)
      if (struct.choch) {
        revScore += 35;
        revTriggers.push('CHoCH');
        revDir = struct.bos === 'up' ? 'UP' : 'DOWN';
      }

      // 2. Liquidity sweep on last completed bar
      //    Wick pierces 20-bar swing level but candle closes back inside
      var prevBar     = bars[bars.length - 2];
      var prevLook    = bars.slice(-23, -2);
      if (prevBar && prevLook.length >= 10) {
        var ph = prevLook[0].high, pl = prevLook[0].low;
        for (var pi = 1; pi < prevLook.length; pi++) {
          if (prevLook[pi].high > ph) ph = prevLook[pi].high;
          if (prevLook[pi].low  < pl) pl = prevLook[pi].low;
        }
        if (prevBar.high > ph && prevBar.close < ph) {
          revScore += 28; revTriggers.push('Sweep↑→↓'); if (!revDir) revDir = 'DOWN';
        }
        if (prevBar.low < pl && prevBar.close > pl) {
          revScore += 28; revTriggers.push('Sweep↓→↑'); if (!revDir) revDir = 'UP';
        }
      }

      // 3. Price at VWAP ±2SD (mean-reversion zone)
      if (vwapD) {
        if (cur.high >= vwapD.upper2 && cur.low <= vwapD.upper2) {
          revScore += 20; revTriggers.push('VWAP+2σ'); if (!revDir) revDir = 'DOWN';
        }
        if (cur.high >= vwapD.lower2 && cur.low <= vwapD.lower2) {
          revScore += 20; revTriggers.push('VWAP-2σ'); if (!revDir) revDir = 'UP';
        }
      }

      // 4. Exhaustion candle at swing extreme
      //    Tiny body (< 30% of range) while price is within 0.2% of swing H/L
      var curBody = (cur.high - cur.low) > 0
        ? Math.abs(cur.close - cur.open) / (cur.high - cur.low) : 0.5;
      var nearSwingH = rangeHigh > 0 && Math.abs(cur.high - rangeHigh) / rangeHigh < 0.002;
      var nearSwingL = rangeLow  > 0 && Math.abs(cur.low  - rangeLow)  / rangeLow  < 0.002;
      if (curBody < 0.30 && (nearSwingH || nearSwingL)) {
        revScore += 18; revTriggers.push('Exhaust');
        if (nearSwingH && !revDir) revDir = 'DOWN';
        if (nearSwingL && !revDir) revDir = 'UP';
      }

      // 5. ATR contraction after a confirmed trend (momentum fading)
      if (atr && atr.ratio < 0.75 && struct.priorTrend !== 'neutral' && struct.bos) {
        revScore += 12; revTriggers.push('ATR↓@trend');
      }

      // 6. Low volume at swing extreme (absorption / lack of follow-through)
      if (volRatio !== null && volRatio < 0.70) {
        var atExtreme = cur.high >= rangeHigh || cur.low <= rangeLow;
        if (atExtreme) { revScore += 12; revTriggers.push('LowVol@lvl'); }
      }

      var revProb = revScore >= 55 ? 'HIGH'
                  : revScore >= 30 ? 'MEDIUM'
                  : revScore >= 15 ? 'LOW'
                  : null;

      // ── TREND vs LIQUIDITY-RAID DISCRIMINATION (raw flags only) ──────────────
      // A confirmed BOS (close beyond the level) and a liquidity sweep (wick
      // beyond the level, close back inside) are structurally mutually exclusive.
      // The trade action is opposite: BOS → continue with the break;
      // sweep → fade it (counter-trend, buy the dip / sell the rip).
      // Final strength/reason is computed Node-side once the yfinance weekly
      // volume ratio is available — see finalizeTradeBias() below.
      var atrExp     = atr ? atr.ratio > 1.2 : false;
      var hasSweep   = revTriggers.indexOf('Sweep↑→↓') !== -1 || revTriggers.indexOf('Sweep↓→↑') !== -1;
      var sweptHighs = revTriggers.indexOf('Sweep↑→↓') !== -1;

      return {
        symbol:       symbol,
        resolution:   res,
        close:        r2(cur.close),
        session:      session,
        regime:       cls.regime,
        confidence:   cls.confidence,
        adjustedScore:cls.adjustedScore,
        trendDir:     trendDir,
        rangeHigh:    rangeHigh,
        rangeLow:     rangeLow,
        layers: {
          structure: {
            score:         struct.score,
            bos:           struct.bos,
            choch:         struct.choch,
            priorTrend:    struct.priorTrend,
            sequence:      struct.sequenceLabel,
            lastSwingHigh: struct.lastSwingHigh,
            lastSwingLow:  struct.lastSwingLow,
          },
          priceAction: {
            atrRatio:    atr ? atr.ratio : null,
            atrScore:    atrScore(atr ? atr.ratio : null),
            bodyRatio:   body,
            bodyScore:   bodyScore(body),
            vwapDev:     vwapDev,
            vwapScore:   vwapScore(vwapDev),
            vwap:        vwapD ? vwapD.vwap : null,
            vwapUpper2:  vwapD ? vwapD.upper2 : null,
            vwapLower2:  vwapD ? vwapD.lower2 : null,
          },
          volume: {
            ratio:          volRatio,
            // weeklyRatio/weeklyBaseline/weeklySamples filled in Node-side from yfinance
            weeklyRatio:    null,
            weeklyBaseline: null,
            weeklySamples:  null,
          },
        },
        reversal: {
          probability: revProb,
          score:       revScore,
          direction:   revDir,
          triggers:    revTriggers,
        },
        // Raw structural flags — Node.js finalizes tradeBias once it has the
        // yfinance weekly volume ratio (see finalizeTradeBias in regime.js)
        _raw: {
          bos:          struct.bos,
          choch:        struct.choch,
          hasSweep:     hasSweep,
          sweptHighs:   sweptHighs,
          atrExpanding: atrExp,
          etHourBucket: Math.floor(etHour(cur.time)),
          lastVolume:   cur.volume,
        },
        tradeBias: { action: 'WAIT', direction: null, strength: null, reason: 'pending' },
      };
    } catch(e) {
      return { symbol: '?', error: e.message };
    }
  }

  // ════════════════════════════════════════════════════════════
  //  ENTRY: analyze all visible panes
  // ════════════════════════════════════════════════════════════

  var cwc = window.TradingViewApi._chartWidgetCollection;
  var all = cwc.getAll();
  var count = cwc.inlineChartsCount;
  if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();
  count = count || all.length;

  var results = [];
  for (var i = 0; i < Math.min(all.length, count); i++) {
    var r = analyzePane(all[i]);
    if (r) results.push(r);
  }

  return { ts: Date.now(), panes: results };

})()
`;

/**
 * Finalize the CONTINUE/FADE/WAIT trade bias once the real yfinance weekly
 * volume ratio is known. Mirrors the logic that previously lived entirely
 * in-browser, just fed by a trustworthy weekly baseline instead of whatever
 * bars TradingView had buffered.
 */
function finalizeTradeBias(raw, wv) {
  if (!raw) return { action: 'WAIT', direction: null, strength: null, reason: 'no structural trigger' };

  if (raw.bos && !raw.choch) {
    const dir = raw.bos === 'up' ? 'UP' : 'DOWN';
    const strength = (wv !== null && wv > 1.4 && raw.atrExpanding) ? 'STRONG'
                    : (wv !== null && wv < 0.8) ? 'WEAK'
                    : 'MODERATE';
    return {
      action: 'CONTINUE',
      direction: dir,
      strength,
      reason: `BOS ${dir}` + (wv !== null ? `, ${wv}x wk-vol` : ', vol n/a') + (raw.atrExpanding ? ', ATR expanding' : ''),
    };
  }

  if (raw.hasSweep) {
    const dir = raw.sweptHighs ? 'DOWN' : 'UP';
    const stopHuntSig = wv !== null && wv > 1.3;
    const strength = stopHuntSig ? 'STRONG' : (wv !== null && wv < 0.8) ? 'WEAK' : 'MODERATE';
    return {
      action: 'FADE',
      direction: dir,
      strength,
      reason: 'liquidity sweep' + (wv !== null ? `, ${wv}x wk-vol` : ', vol n/a') + (stopHuntSig ? ' (stop-hunt signature)' : ''),
    };
  }

  return { action: 'WAIT', direction: null, strength: null, reason: 'no structural trigger' };
}

export async function analyzeRegime() {
  const result = await evaluate(REGIME_JS);
  if (!result || !result.panes) return result;

  const symbols = result.panes.map(p => p.symbol).filter(Boolean);
  await ensureFreshBaselines(symbols);

  for (const p of result.panes) {
    if (p.error || !p._raw) continue;
    // Baseline is sourced as 1-minute bars from yfinance — only valid to compare
    // against a chart that's also on 1-minute resolution (otherwise the bar
    // volumes aren't the same unit and the ratio is meaningless).
    const wvData = p.resolution === '1'
      ? getWeeklyRatio(p.symbol, p._raw.etHourBucket, p._raw.lastVolume)
      : null;
    const wv = wvData ? wvData.ratio : null;

    p.layers.volume.weeklyRatio    = wv;
    p.layers.volume.weeklyBaseline = wvData ? wvData.baseline : null;
    p.layers.volume.weeklySamples  = wvData ? wvData.samples  : null;

    p.tradeBias = finalizeTradeBias(p._raw, wv);
    delete p._raw;
  }

  return result;
}
