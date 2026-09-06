/**
 * Converts a raw detector match into a standard trading-plan shape:
 * Buy Area / Cutloss (or trailing stop) / TP1 / TP2.
 *
 * Formulas follow each setup's own textbook measured-move math — this is
 * NOT personalized financial advice, it is a mechanical application of
 * standard technical-analysis levels. Always re-verify manually before
 * acting; these are reference levels, not certainties.
 */
import { nearestResistanceAbove, nearestSupportBelow } from './support_resistance.js';

function atr(bars, period = 14) {
  const slice = bars.slice(-period - 1);
  if (slice.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const cur = slice[i], prev = slice[i - 1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    sum += tr;
  }
  return sum / (slice.length - 1);
}

// IDX stocks trade in whole Rupiah — round to the nearest integer for a
// readable report instead of leaving float noise like "6316.785714".
const round = (v) => (v == null ? null : Math.round(v));

// Backtest (100 symbols) showed the wave-2-based criteria's original 0.5x
// ATR cutloss buffer was too tight — normal day-to-day noise stopped trades
// out before the (correctly-directioned) move had room to develop. Widened
// to 1.5x ATR, floored at a straight 3% below the level so thin-ATR names
// still get a meaningful buffer.
function wideCutloss(level, bars) {
  const a = atr(bars, 14);
  return Math.min(level - a * 1.5, level * 0.97);
}

export function buildTradingPlan(criterion, match, bars, srZones) {
  const plan = buildTradingPlanRaw(criterion, match, bars, srZones);
  if (!plan) return plan;

  // TP1 must be the nearer/easier target and TP2 the further one — some
  // formulas (e.g. breakout_resistance_with_volume mixing a measured-move
  // projection with "next resistance zone") can produce them out of order.
  if (plan.take_profit_1 != null && plan.take_profit_2 != null && plan.take_profit_1 > plan.take_profit_2) {
    [plan.take_profit_1, plan.take_profit_2] = [plan.take_profit_2, plan.take_profit_1];
  }

  const last = bars[bars.length - 1];

  // A take-profit at or below today's close means the underlying setup's
  // target was already reached before the pattern was even detected — the
  // signal is stale, not a live opportunity. Reject the whole plan rather
  // than hand back a target that's behind the current price.
  if (plan.take_profit_1 != null && plan.take_profit_1 <= last.close) return null;

  // Buy area's lower bound is the setup's actual reference point (breakout
  // level, wave pivot, SMA50). If that's already far below today's close, the
  // stock isn't "about to move" — it already ran. This is REJECTED outright,
  // not clamped for display: the goal is catching names still near their base
  // (accumulation, early breakout), not ones that already flew and are being
  // chased. 10% is the ceiling for how extended a live setup is allowed to be.
  const buyLow = Number(plan.buy_area.split(' - ')[0]);
  if (buyLow < last.close * 0.90) return null;

  // Cutloss must sit strictly below the buy area —
  // a stop level at or inside the entry range protects nothing.
  if (plan.cutloss != null && plan.cutloss >= buyLow) {
    plan.cutloss = Math.round(buyLow * 0.97);
  }

  return plan;
}

function buildTradingPlanRaw(criterion, match, bars, srZones) {
  const last = bars[bars.length - 1];
  const a = atr(bars, 14);

  switch (criterion) {
    case 'elliott_wave': {
      const buyLow = match.wave_points.w4.price;
      const buyHigh = last.close;
      return {
        buy_area: `${round(buyLow)} - ${round(buyHigh)}`,
        cutloss: round(match.invalidation_level - a * 0.5),
        take_profit_1: round(match.wave5_targets.tp1_0618),
        take_profit_2: round(match.wave5_targets.tp2_1000),
        extended_target: round(match.wave5_targets.extended_1618),
        method: 'Elliott Wave — TP di proyeksi wave 5 dari wave 4 (fib 0.618x / 1.0x panjang wave 1). Cutloss di bawah invalidation wave 4.',
      };
    }
    case 'elliott_wave2': {
      const buyLow = match.pullback_low;
      const buyHigh = last.close;
      return {
        buy_area: `${round(buyLow)} - ${round(buyHigh)}`,
        cutloss: round(wideCutloss(match.invalidation_level, bars)),
        take_profit_1: round(match.wave3_targets.tp0_0618),
        take_profit_2: round(match.wave3_targets.tp1_1618),
        extended_target: round(match.wave3_targets.tp2_2618),
        method: 'Elliott Wave 2 (entry paling awal, risiko lebih tinggi) — lower high vs wave 1 + candle hijau menandakan wave 2 sedang dipertahankan pembeli. TP1 di proyeksi 61.8% (target terdekat), TP2 di 161.8% panjang wave 1 dari titik terendah wave 2. Cutloss dilebarkan (1.5x ATR / min 3%) di bawah titik terendah itu — wave 2 masih mungkin melanjutkan turun sebelum benar-benar berbalik.',
      };
    }
    case 'pullback_reversal': {
      const buyLow = match.pullback_low;
      const buyHigh = last.close;
      return {
        buy_area: `${round(buyLow)} - ${round(buyHigh)}`,
        cutloss: round(wideCutloss(match.invalidation_level, bars)),
        take_profit_1: round(match.targets.expansion_0618),
        take_profit_2: round(match.targets.expansion_1618),
        extended_target: round(match.targets.expansion_2618),
        method: `Reversal dari pullback wave 2 — retrace ${match.retrace_pct}% dari wave 1 (${match.fib_zone}), dikonfirmasi candle hijau. TP1 = ekspansi fib 61.8% (target terdekat), TP2 = ekspansi 161.8% (= target wave 3). Extended target = ekspansi 261.8%. Cutloss dilebarkan (1.5x ATR / min 3%) di bawah titik terendah pullback.`,
      };
    }
    case 'double_bottom':
    case 'inverse_head_and_shoulders':
    case 'cup_and_handle':
    case 'bullish_flag':
    case 'bullish_pennant': {
      const breakoutLevel = match.rim_level ?? match.neckline ?? match.breakout_level;
      return {
        buy_area: `${round(breakoutLevel)} - ${round(last.close)}`,
        cutloss: round(match.invalidation_level - a * 0.3),
        take_profit_1: round((breakoutLevel + (match.measured_move_target - breakoutLevel) * 0.5)),
        take_profit_2: round(match.measured_move_target),
        method: `Measured move ${match.pattern} — TP2 = breakout + kedalaman pola (rumus baku pattern ini). TP1 = 50% jalan menuju target.`,
      };
    }
    case 'breakout_resistance_with_volume': {
      const res = match.resistance_level;
      const nextRes = nearestResistanceAbove(srZones, res * 1.001);
      // retest_low (the actual bottom of the multi-day pullback that tested
      // the broken resistance) is a more precise invalidation point than a
      // generic ATR buffer below the resistance level itself.
      const cutlossBase = match.retest_low ?? res;
      return {
        buy_area: `${round(res)} - ${round(last.close)}`,
        cutloss: round(cutlossBase - a * 0.3),
        take_profit_1: round(res + (res - (nearestSupportBelow(srZones, res)?.price ?? res * 0.95))),
        take_profit_2: nextRes ? round(nextRes.price) : round(res * 1.08),
        method: `Breakout resistance + volume — resistance ${round(res)} ditembus, pullback ${match.pullback_days ?? '?'} hari (aksi take profit) turun retest ke ${round(cutlossBase)}, lalu bounce candle hijau mengonfirmasi level ini jadi support baru. Cutloss di bawah titik retest. TP mengacu ke resistance berikutnya.`,
      };
    }
    case 'volume_spike_green_candle': {
      const res = nearestResistanceAbove(srZones, last.close);
      const sup = nearestSupportBelow(srZones, last.close);
      return {
        buy_area: `${round(last.open)} - ${round(last.close)}`,
        cutloss: round((sup?.price ?? last.low) - a * 0.3),
        take_profit_1: res ? round(res.price) : round(last.close * 1.05),
        take_profit_2: round(last.close + (last.close - (sup?.price ?? last.low)) * 1.5),
        method: 'Volume spike + candle hijau — cutloss di bawah support terdekat, TP1 ke resistance terdekat.',
      };
    }
    case 'downtrend_break': {
      const res = nearestResistanceAbove(srZones, last.close);
      return {
        buy_area: `${round(match.line_value_now)} - ${round(last.close)}`,
        cutloss: round(match.line_value_now - a * 0.6),
        take_profit_1: res ? round(res.price) : round(last.close * 1.06),
        take_profit_2: round(last.close + (last.close - match.line_value_now) * 2),
        method: 'Breakout downtrend line — cutloss di bawah garis trendline yang ditembus, TP mengacu resistance/measured move dari lebar breakout.',
      };
    }
    case 'confirmed_uptrend': {
      const res = nearestResistanceAbove(srZones, last.close);
      const sup = nearestSupportBelow(srZones, last.close);
      return {
        buy_area: `${round(match.sma50)} - ${round(last.close)}`,
        cutloss: round((sup?.price ?? match.sma50) - a * 0.5),
        take_profit_1: res ? round(res.price) : round(last.close * 1.05),
        take_profit_2: round(last.close * 1.10),
        method: 'Trend following — trailing stop di bawah SMA50/support terdekat, TP ke resistance berikutnya.',
      };
    }
    default:
      return null;
  }
}
