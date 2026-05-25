// Options chain + unusual activity — ported from
// atilaahmettaner/options_service.py. Uses yahoo-finance2 which handles
// the crumb/cookie session internally.

import * as YF from 'yahoo-finance2';

const SUPPRESS = ['ripHistorical', 'yahooSurvey'];
const yahooFinance = (() => {
  if (YF.YahooFinance) return new YF.YahooFinance({ suppressNotices: SUPPRESS });
  if (YF.default && typeof YF.default === 'function') return new YF.default({ suppressNotices: SUPPRESS });
  return YF.default || YF;
})();

function fmtExpiryDate(d) {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

function safeRound(value, ndigits = 4) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, ndigits);
  return Math.round(n * f) / f;
}

function normalizeContract(c, side) {
  return {
    contract_symbol: c.contractSymbol,
    side,
    strike: safeRound(c.strike, 2),
    last_price: safeRound(c.lastPrice, 2),
    bid: safeRound(c.bid, 2),
    ask: safeRound(c.ask, 2),
    volume: c.volume || 0,
    open_interest: c.openInterest || 0,
    implied_volatility: safeRound(c.impliedVolatility, 4),
    in_the_money: c.inTheMoney,
    expiration: fmtExpiryDate(c.expiration),
  };
}

export async function getOptionsChain(symbol, expiry = null) {
  const sym = symbol.trim().toUpperCase();
  let data;
  try {
    data = await yahooFinance.options(sym);
  } catch (err) {
    return { symbol: sym, error: err.message };
  }
  if (!data || !data.options || !data.options.length) {
    return { symbol: sym, error: 'no options data for symbol' };
  }

  const underlying = data.quote || {};
  const expirations = data.expirationDates || [];
  const availableIso = expirations.map(fmtExpiryDate);

  let targetTs = null;
  if (expiry) {
    const match = expirations.find(d => fmtExpiryDate(d) === expiry);
    if (!match) {
      return {
        symbol: sym,
        error: `expiry ${expiry} not available`,
        available_expiries: availableIso,
      };
    }
    targetTs = match;
    try {
      data = await yahooFinance.options(sym, { date: new Date(targetTs) });
    } catch (err) {
      return { symbol: sym, error: `failed to fetch expiry: ${err.message}` };
    }
  }

  const blocks = data.options || [];
  if (!blocks.length) {
    return {
      symbol: sym,
      underlying_price: safeRound(underlying.regularMarketPrice, 2),
      requested_expiry: expiry,
      available_expiries: availableIso,
      calls: [],
      puts: [],
      note: 'no contracts returned for this expiry',
    };
  }

  const block = blocks[0];
  const calls = (block.calls || []).map(c => normalizeContract(c, 'call'));
  const puts = (block.puts || []).map(p => normalizeContract(p, 'put'));

  return {
    symbol: sym,
    underlying_price: safeRound(underlying.regularMarketPrice, 2),
    underlying_change_pct: safeRound(underlying.regularMarketChangePercent, 2),
    requested_expiry: fmtExpiryDate(block.expirationDate),
    available_expiries: availableIso,
    call_count: calls.length,
    put_count: puts.length,
    calls,
    puts,
    source: 'Yahoo Finance',
  };
}

export async function getUnusualOptionsActivity(symbol, opts = {}) {
  const { top_n = 10, min_volume = 100, expiries = 4 } = opts;
  const sym = symbol.trim().toUpperCase();

  let data;
  try {
    data = await yahooFinance.options(sym);
  } catch (err) {
    return { symbol: sym, error: err.message };
  }
  if (!data || !data.expirationDates) {
    return { symbol: sym, error: 'no options data for symbol' };
  }

  const underlying = data.quote || {};
  const underlyingPrice = safeRound(underlying.regularMarketPrice, 2);
  const expirationsTs = (data.expirationDates || []).slice(0, Math.max(1, expiries));

  const allContracts = [];
  const fetchedExpiries = [];
  let totalCallVol = 0;
  let totalPutVol = 0;

  for (const ts of expirationsTs) {
    let d;
    try {
      d = await yahooFinance.options(sym, { date: new Date(ts) });
    } catch {
      continue;
    }
    const blk = d?.options?.[0];
    if (!blk) continue;
    fetchedExpiries.push(fmtExpiryDate(ts));
    for (const c of blk.calls || []) {
      const v = c.volume || 0;
      totalCallVol += v;
      allContracts.push(normalizeContract(c, 'call'));
    }
    for (const p of blk.puts || []) {
      const v = p.volume || 0;
      totalPutVol += v;
      allContracts.push(normalizeContract(p, 'put'));
    }
  }

  if (!allContracts.length) {
    return {
      symbol: sym,
      error: 'no contracts returned across requested expiries',
      expiries_scanned: fetchedExpiries,
    };
  }

  const ranked = [];
  for (const c of allContracts) {
    const vol = c.volume || 0;
    const oi = c.open_interest || 0;
    if (vol < min_volume) continue;
    const ratio = vol / Math.max(oi, 1);
    let moneyness = null;
    if (underlyingPrice != null && c.strike != null) {
      moneyness = Number((((c.strike - underlyingPrice) / underlyingPrice) * 100).toFixed(2));
    }
    ranked.push({
      contract_symbol: c.contract_symbol,
      side: c.side,
      strike: c.strike,
      expiration: c.expiration,
      volume: vol,
      open_interest: oi,
      v_oi_ratio: Number(ratio.toFixed(2)),
      last_price: c.last_price,
      implied_volatility: c.implied_volatility,
      in_the_money: c.in_the_money,
      strike_vs_spot_pct: moneyness,
    });
  }
  ranked.sort((a, b) => b.v_oi_ratio - a.v_oi_ratio);

  return {
    symbol: sym,
    underlying_price: underlyingPrice,
    expiries_scanned: fetchedExpiries,
    total_call_volume: totalCallVol,
    total_put_volume: totalPutVol,
    put_call_volume_ratio:
      totalCallVol > 0 ? Number((totalPutVol / totalCallVol).toFixed(2)) : null,
    unusual: ranked.slice(0, top_n),
    source: 'Yahoo Finance',
  };
}
