// Indicator signal computation — ported from
// atilaahmettaner/indicators.py:extract_extended_indicators.
// Compact subset covering the most-used signals (RSI, MACD, BB, SMA/EMA stack,
// Stoch, ADX, pivot S/R). Future commits can extend.

function safeRound(value, decimals = 4) {
  if (value == null || !Number.isFinite(value)) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function rsiSignal(value) {
  if (value == null) return 'Neutral';
  if (value > 70) return 'Overbought';
  if (value > 60) return 'Bullish';
  if (value < 30) return 'Oversold';
  if (value < 40) return 'Bearish';
  return 'Neutral';
}

function bbPosition(close, upper, middle, lower) {
  if ([close, upper, middle, lower].some(v => v == null)) return 'Unknown';
  if (close > upper) return 'Above Upper';
  if (close > middle) return 'Upper Half';
  if (close < lower) return 'Below Lower';
  if (close < middle) return 'Lower Half';
  return 'Middle';
}

function maSignals(close, smas, emas) {
  const sigs = [];
  if (close != null && smas.sma50 != null) {
    sigs.push(close > smas.sma50 ? 'Price above SMA50 (bullish)' : 'Price below SMA50 (bearish)');
  }
  if (close != null && smas.sma200 != null) {
    sigs.push(close > smas.sma200 ? 'Price above SMA200 (long-term bullish)' : 'Price below SMA200 (long-term bearish)');
  }
  if (smas.sma50 != null && smas.sma200 != null) {
    sigs.push(smas.sma50 < smas.sma200 ? 'Death Cross (SMA50 < SMA200)' : 'Golden Cross (SMA50 > SMA200)');
  }
  if (close != null && emas.ema20 != null) {
    sigs.push(close > emas.ema20 ? 'Price above EMA20 (short-term bullish)' : 'Price below EMA20 (short-term bearish)');
  }
  if (emas.ema50 != null && emas.ema200 != null) {
    sigs.push(emas.ema50 < emas.ema200 ? 'EMA Death Cross (EMA50 < EMA200)' : 'EMA Golden Cross (EMA50 > EMA200)');
  }
  return sigs;
}

export function extractExtendedIndicators(ind) {
  const close = ind.close ?? null;
  const open  = ind.open  ?? null;
  const high  = ind.high  ?? null;
  const low   = ind.low   ?? null;
  const volume = ind.volume ?? null;

  // ── RSI ──
  const rsi = {
    value: safeRound(ind.RSI, 2),
    previous: safeRound(ind['RSI[1]'], 2),
    signal: rsiSignal(ind.RSI),
    direction: ind.RSI != null && ind['RSI[1]'] != null
      ? (ind.RSI > ind['RSI[1]'] ? 'Rising' : 'Falling') : 'Unknown',
  };

  // ── MACD ──
  const macdLine = ind['MACD.macd'];
  const macdSignal = ind['MACD.signal'];
  const macd = {
    macd_line: safeRound(macdLine, 6),
    signal_line: safeRound(macdSignal, 6),
    histogram: safeRound((macdLine != null && macdSignal != null) ? macdLine - macdSignal : null, 6),
    crossover:
      macdLine != null && macdSignal != null
        ? (macdLine > macdSignal ? 'Bullish' : 'Bearish')
        : 'Unknown',
  };

  // ── Bollinger Bands ──
  const bbUpper = ind['BB.upper'];
  const bbLower = ind['BB.lower'];
  const bbMiddle = ind.SMA20;
  const bb = {
    upper: safeRound(bbUpper, 2),
    middle: safeRound(bbMiddle, 2),
    lower: safeRound(bbLower, 2),
    width: (bbUpper != null && bbLower != null && bbMiddle)
      ? safeRound((bbUpper - bbLower) / bbMiddle, 4)
      : null,
    position: bbPosition(close, bbUpper, bbMiddle, bbLower),
  };

  // ── SMA / EMA stack ──
  const smas = {
    sma10:  safeRound(ind.SMA10, 4),
    sma20:  safeRound(ind.SMA20, 4),
    sma30:  safeRound(ind.SMA30, 4),
    sma50:  safeRound(ind.SMA50, 4),
    sma100: safeRound(ind.SMA100, 4),
    sma200: safeRound(ind.SMA200, 4),
  };
  const emas = {
    ema10:  safeRound(ind.EMA10, 4),
    ema20:  safeRound(ind.EMA20, 4),
    ema30:  safeRound(ind.EMA30, 4),
    ema50:  safeRound(ind.EMA50, 4),
    ema100: safeRound(ind.EMA100, 4),
    ema200: safeRound(ind.EMA200, 4),
  };

  // ── Stochastic ──
  const stoch = {
    k: safeRound(ind['Stoch.K'], 2),
    d: safeRound(ind['Stoch.D'], 2),
    signal:
      ind['Stoch.K'] != null
        ? (ind['Stoch.K'] > 80 ? 'Overbought'
          : ind['Stoch.K'] < 20 ? 'Oversold' : 'Neutral')
        : 'Unknown',
  };

  // ── ADX ──
  const adxValue = ind.ADX;
  const adx = {
    value: safeRound(adxValue, 2),
    trend_strength:
      adxValue == null ? 'Unknown'
      : adxValue > 50 ? 'Very Strong'
      : adxValue > 25 ? 'Strong'
      : adxValue > 20 ? 'Moderate'
      : 'Weak/No Trend',
    plus_di: safeRound(ind['ADX+DI'], 2),
    minus_di: safeRound(ind['ADX-DI'], 2),
    di_signal:
      ind['ADX+DI'] != null && ind['ADX-DI'] != null
        ? (ind['ADX+DI'] > ind['ADX-DI'] ? 'Bullish (+DI > -DI)' : 'Bearish (-DI > +DI)')
        : 'Unknown',
  };

  // ── Pivot Support/Resistance (classic, monthly) ──
  const sr = {
    pivot:       safeRound(ind['Pivot.M.Classic.Middle'], 2),
    resistance_1: safeRound(ind['Pivot.M.Classic.R1'], 2),
    resistance_2: safeRound(ind['Pivot.M.Classic.R2'], 2),
    resistance_3: safeRound(ind['Pivot.M.Classic.R3'], 2),
    support_1:    safeRound(ind['Pivot.M.Classic.S1'], 2),
    support_2:    safeRound(ind['Pivot.M.Classic.S2'], 2),
    support_3:    safeRound(ind['Pivot.M.Classic.S3'], 2),
  };
  if (close != null && sr.resistance_1 != null) {
    sr.nearest_resistance = sr.resistance_1;
    sr.distance_to_resistance_pct = safeRound(((sr.resistance_1 - close) / close) * 100, 2);
  }
  if (close != null && sr.support_1 != null) {
    sr.nearest_support = sr.support_1;
    sr.distance_to_support_pct = safeRound(((close - sr.support_1) / close) * 100, 2);
  }

  // ── Volume / OBV (simple, no historical) ──
  const volumeAnalysis = {
    current: volume,
    signal: volume != null && volume > 0 ? 'Normal' : 'Unknown',
  };
  const obv = {
    current_volume: volume,
    direction:
      close != null && open != null
        ? (close >= open ? 'accumulation' : 'distribution')
        : 'unknown',
    note: 'OBV direction inferred from current candle (close vs open)',
  };

  // ── TV native recommendations ──
  const recoMap = (v) => {
    if (v == null) return 'Unknown';
    if (v >= 0.5) return 'STRONG_BUY';
    if (v >= 0.1) return 'BUY';
    if (v <= -0.5) return 'STRONG_SELL';
    if (v <= -0.1) return 'SELL';
    return 'NEUTRAL';
  };

  // ── Aggregate market structure ──
  let trendScore = 0;
  if (close != null && smas.sma50 != null) trendScore += close > smas.sma50 ? 1 : -1;
  if (close != null && smas.sma200 != null) trendScore += close > smas.sma200 ? 1 : -1;
  if (rsi.value != null) trendScore += rsi.value > 50 ? 1 : -1;

  const marketStructure = {
    trend:
      trendScore > 1 ? 'Bullish'
      : trendScore < -1 ? 'Bearish'
      : 'Neutral/Ranging',
    trend_score: trendScore,
    trend_strength: adx.trend_strength,
    momentum_aligned:
      (macd.crossover === 'Bullish' && rsi.value != null && rsi.value > 50) ||
      (macd.crossover === 'Bearish' && rsi.value != null && rsi.value < 50),
    trend_signals: maSignals(close, smas, emas),
  };

  return {
    price_data: {
      current_price: safeRound(close, 4),
      open: safeRound(open, 4),
      high: safeRound(high, 4),
      low: safeRound(low, 4),
      change_percent: safeRound(ind.change, 3),
      volume,
    },
    rsi,
    macd,
    bollinger_bands: bb,
    sma: smas,
    ema: emas,
    stochastic: stoch,
    adx,
    support_resistance: sr,
    volume_analysis: volumeAnalysis,
    obv,
    market_sentiment: {
      overall_rating: recoMap(ind['Recommend.All']),
      ma_rating: recoMap(ind['Recommend.MA']),
      oscillator_rating: recoMap(ind['Recommend.Other']),
    },
    market_structure: marketStructure,
  };
}
