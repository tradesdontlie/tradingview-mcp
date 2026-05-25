// Yahoo Finance wrapper — ported from atilaahmettaner/yahoo_finance_service.py
// Works with any symbol Yahoo supports: stocks (AAPL), crypto (BTC-USD),
// ETFs (SPY), indices (^GSPC), FX (EURUSD=X), Turkish (THYAO.IS), NSE (.NS), BSE (.BO).

// yahoo-finance2 v3 requires instantiation; v2 used default singleton.
// Support both for forward/backward compat.
import * as YF from 'yahoo-finance2';

const SUPPRESS = ['ripHistorical', 'yahooSurvey'];
const yahooFinance = (() => {
  if (YF.YahooFinance) return new YF.YahooFinance({ suppressNotices: SUPPRESS });
  if (YF.default && typeof YF.default === 'function') return new YF.default({ suppressNotices: SUPPRESS });
  return YF.default || YF;
})();

export async function getPrice(symbol) {
  try {
    const q = await yahooFinance.quote(symbol);
    const price = q.regularMarketPrice ?? null;
    const prevClose = q.regularMarketPreviousClose ?? q.chartPreviousClose ?? price;
    const change = (price != null && prevClose != null) ? Number((price - prevClose).toFixed(4)) : null;
    const changePct = (price != null && prevClose != null && prevClose !== 0)
      ? Number((((price - prevClose) / prevClose) * 100).toFixed(2))
      : null;

    return {
      symbol: symbol.toUpperCase(),
      price,
      previous_close: prevClose,
      change,
      change_pct: changePct,
      currency: q.currency || 'USD',
      exchange: q.fullExchangeName || q.exchange || '',
      market_state: q.marketState || '',
      '52w_high': q.fiftyTwoWeekHigh ?? null,
      '52w_low': q.fiftyTwoWeekLow ?? null,
      source: 'Yahoo Finance',
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      symbol: symbol.toUpperCase(),
      error: err.message,
      source: 'Yahoo Finance',
      timestamp: new Date().toISOString(),
    };
  }
}

export async function getPricesBulk(symbols) {
  return Promise.all(symbols.map(s => getPrice(s)));
}

export async function getMarketSnapshot() {
  const groups = {
    indices: ['^GSPC', '^DJI', '^IXIC', '^VIX'],
    crypto:  ['BTC-USD', 'ETH-USD', 'SOL-USD', 'BNB-USD'],
    fx:      ['EURUSD=X', 'GBPUSD=X', 'JPYUSD=X'],
    etfs:    ['SPY', 'QQQ', 'GLD'],
  };

  const result = {};
  for (const [group, syms] of Object.entries(groups)) {
    const rows = await Promise.all(syms.map(s => getPrice(s)));
    result[group] = rows
      .filter(r => !r.error)
      .map(r => ({
        symbol: r.symbol,
        price: r.price,
        change_pct: r.change_pct,
        currency: r.currency,
      }));
  }
  result.timestamp = new Date().toISOString();
  return result;
}
