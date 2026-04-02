/**
 * Core fundamentals & analysis data.
 *
 * Uses TradingView's scanner REST API (scanner.tradingview.com) for
 * technicals, financials, and screener-style data.  Runs fetch() inside
 * the browser context so auth cookies are inherited automatically.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS } from '../connection.js';

const CHART_API = KNOWN_PATHS.chartApi;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the current chart symbol in EXCHANGE:TICKER format + metadata. */
async function resolveSymbol(symbolArg) {
  const info = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var ext = chart.symbolExt() || {};
      return {
        symbol:    ext.symbol    || chart.symbol(),
        full_name: ext.full_name || chart.symbol(),
        exchange:  ext.exchange  || '',
        type:      ext.type      || '',
        typespecs: ext.typespecs || [],
        description: ext.description || '',
      };
    })()
  `);
  if (symbolArg) {
    // Caller supplied explicit symbol – use it, but keep detected metadata
    const hasPfx = symbolArg.includes(':');
    return {
      ...info,
      full_name: hasPfx ? symbolArg : (info.exchange ? info.exchange + ':' + symbolArg : symbolArg),
      symbol: hasPfx ? symbolArg.split(':')[1] : symbolArg,
    };
  }
  return info;
}

/** Map exchange → scanner screener slug. */
function screenerFor(exchange, type) {
  if (/crypto/i.test(type)) return 'crypto';
  if (/forex/i.test(type)) return 'forex';
  if (/cfd/i.test(type)) return 'cfd';
  const ex = (exchange || '').toUpperCase();
  const map = {
    NASDAQ: 'america', NYSE: 'america', AMEX: 'america', 'NYSE ARCA': 'america',
    BATS: 'america', OTC: 'america', CBOE: 'america',
    CME: 'america', NYMEX: 'america', COMEX: 'america', CBOT: 'america',
    CME_MINI: 'america', 'CME GLOBEX': 'america',
    TSX: 'canada', TSXV: 'canada', CSE: 'canada', NEO: 'canada',
    LSE: 'uk', LON: 'uk',
    XETR: 'germany', FWB: 'germany',
    EURONEXT: 'france', EPA: 'france',
    BME: 'spain', MIL: 'italy', SIX: 'switzerland',
    TSE: 'japan', TYO: 'japan',
    HKEX: 'hongkong', SSE: 'china', SZSE: 'china',
    NSE: 'india', BSE: 'india',
    ASX: 'australia', NZX: 'newzealand',
    KRX: 'korea', TWSE: 'taiwan',
    BINANCE: 'crypto', COINBASE: 'crypto', KRAKEN: 'crypto', BYBIT: 'crypto',
    BITSTAMP: 'crypto', OKX: 'crypto', BITFINEX: 'crypto',
    FX: 'forex', OANDA: 'forex', FXCM: 'forex', FX_IDC: 'forex', FOREXCOM: 'forex',
    TVC: 'america', INDEX: 'america', DJ: 'america', SP: 'america',
  };
  return map[ex] || 'america';
}

/**
 * Generic scanner API call.  Returns { columns, values } where values is a
 * parallel array to columns, or { error }.
 */
async function scannerFetch(fullName, columns, exchange, type) {
  const screener = screenerFor(exchange, type);
  const body = JSON.stringify({
    symbols: { tickers: [fullName] },
    columns,
  });

  const result = await evaluateAsync(`
    (function() {
      return fetch('https://scanner.tradingview.com/${screener}/scan', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://www.tradingview.com',
          'Referer': 'https://www.tradingview.com/',
        },
        body: ${JSON.stringify(body)},
      })
        .then(function(r) { if (!r.ok) return { error: 'HTTP ' + r.status }; return r.json(); })
        .then(function(data) {
          if (!data || !data.data || !data.data.length) return { error: 'No data returned' };
          return { values: data.data[0].d };
        })
        .catch(function(e) { return { error: e.message }; });
    })()
  `);

  if (!result || result.error) return { error: result?.error || 'Scanner fetch failed' };
  // Build a name→value map
  const map = {};
  for (let i = 0; i < columns.length; i++) {
    map[columns[i]] = result.values[i];
  }
  return { data: map };
}

// ---------------------------------------------------------------------------
// 1. Discovery – what data is available for this symbol?
// ---------------------------------------------------------------------------

export async function getAvailableData({ symbol } = {}) {
  const info = await resolveSymbol(symbol);
  const t = (info.type || '').toLowerCase();
  const typespecs = (info.typespecs || []).map(s => s.toLowerCase());

  const isStock  = t === 'stock';
  const isETF    = t === 'fund' || typespecs.includes('etf');
  const isCrypto = t === 'crypto';
  const isForex  = t === 'forex';
  const isFutures = t === 'futures';
  const isIndex  = t === 'index';

  const available = {
    news:        true,             // all assets
    technicals:  true,             // all assets
    seasonals:   true,             // all assets (computed from price history)
  };

  if (isStock) {
    available.financials = {
      overview: true,
      income_statement: true,
      balance_sheet: true,
      cash_flow: true,
      statistics: true,
      dividends: true,
      earnings: true,
    };
  }

  if (isETF) {
    available.etf_profile = {
      overview: true,
      holdings: true,
    };
    // ETFs also have some financial overview
    available.financials = {
      overview: true,
      dividends: true,
    };
  }

  return {
    success: true,
    symbol: info.full_name,
    description: info.description,
    exchange: info.exchange,
    asset_type: info.type,
    typespecs: info.typespecs,
    available_data: available,
  };
}

// ---------------------------------------------------------------------------
// 2. Technicals
// ---------------------------------------------------------------------------

const TECH_COLUMNS = [
  // Summary
  'Recommend.All', 'Recommend.MA', 'Recommend.Other',
  // Oscillators
  'RSI', 'RSI[1]', 'Stoch.K', 'Stoch.D', 'Stoch.K[1]', 'Stoch.D[1]',
  'CCI20', 'CCI20[1]', 'ADX', 'ADX+DI', 'ADX-DI', 'ADX+DI[1]', 'ADX-DI[1]',
  'AO', 'AO[1]', 'AO[2]', 'Mom', 'Mom[1]',
  'MACD.macd', 'MACD.signal',
  'BBPower', 'Stoch.RSI.K', 'Stoch.RSI.D', 'W.R', 'UO',
  // MAs
  'SMA10', 'SMA20', 'SMA30', 'SMA50', 'SMA100', 'SMA200',
  'EMA10', 'EMA20', 'EMA30', 'EMA50', 'EMA100', 'EMA200',
  // Price context
  'close', 'open', 'high', 'low', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y',
  'volatility_w', 'volatility_m', 'ATR', 'average_volume_10d_calc', 'volume',
];

function ratingLabel(val) {
  if (val == null) return 'N/A';
  if (val >= 0.5) return 'Strong Buy';
  if (val >= 0.1) return 'Buy';
  if (val > -0.1) return 'Neutral';
  if (val > -0.5) return 'Sell';
  return 'Strong Sell';
}

export async function getTechnicals({ symbol } = {}) {
  const info = await resolveSymbol(symbol);
  const scan = await scannerFetch(info.full_name, TECH_COLUMNS, info.exchange, info.type);
  if (scan.error) return { success: false, symbol: info.full_name, error: scan.error };
  const d = scan.data;

  return {
    success: true,
    symbol: info.full_name,
    source: 'scanner_api',
    summary: {
      overall:  { value: d['Recommend.All'],   rating: ratingLabel(d['Recommend.All']) },
      moving_averages: { value: d['Recommend.MA'], rating: ratingLabel(d['Recommend.MA']) },
      oscillators: { value: d['Recommend.Other'], rating: ratingLabel(d['Recommend.Other']) },
    },
    oscillators: {
      RSI:           d['RSI'],
      Stochastic_K:  d['Stoch.K'],
      Stochastic_D:  d['Stoch.D'],
      CCI:           d['CCI20'],
      ADX:           d['ADX'],
      'ADX+DI':      d['ADX+DI'],
      'ADX-DI':      d['ADX-DI'],
      Awesome_Osc:   d['AO'],
      Momentum:      d['Mom'],
      MACD:          d['MACD.macd'],
      MACD_Signal:   d['MACD.signal'],
      BBPower:       d['BBPower'],
      Stoch_RSI_K:   d['Stoch.RSI.K'],
      Stoch_RSI_D:   d['Stoch.RSI.D'],
      Williams_R:    d['W.R'],
      Ultimate_Osc:  d['UO'],
    },
    moving_averages: {
      SMA10: d['SMA10'], SMA20: d['SMA20'], SMA30: d['SMA30'],
      SMA50: d['SMA50'], SMA100: d['SMA100'], SMA200: d['SMA200'],
      EMA10: d['EMA10'], EMA20: d['EMA20'], EMA30: d['EMA30'],
      EMA50: d['EMA50'], EMA100: d['EMA100'], EMA200: d['EMA200'],
    },
    performance: {
      week: d['Perf.W'], month_1: d['Perf.1M'], month_3: d['Perf.3M'],
      month_6: d['Perf.6M'], ytd: d['Perf.YTD'], year: d['Perf.Y'],
    },
    volatility: {
      weekly: d['volatility_w'], monthly: d['volatility_m'], ATR: d['ATR'],
    },
    price: { close: d['close'], open: d['open'], high: d['high'], low: d['low'] },
    volume: { current: d['volume'], avg_10d: d['average_volume_10d_calc'] },
  };
}

// ---------------------------------------------------------------------------
// 3. Financials
// ---------------------------------------------------------------------------

const FIN_OVERVIEW_COLS = [
  'market_cap_basic', 'enterprise_value_fq', 'price_earnings_ttm', 'price_revenue_ttm',
  'price_book_fq', 'price_sales_current', 'enterprise_value_ebitda_ttm',
  'earnings_per_share_diluted_ttm', 'earnings_per_share_diluted_yoy_growth_ttm',
  'revenue_per_employee', 'number_of_employees',
  'sector', 'industry',
  'description',
];

const FIN_INCOME_COLS = [
  'total_revenue', 'gross_profit', 'oper_income', 'net_income', 'ebitda',
  'total_revenue_yoy_growth_ttm', 'net_income_yoy_growth_ttm',
  'earnings_per_share_basic_ttm', 'earnings_per_share_diluted_ttm',
  'gross_margin', 'operating_margin', 'net_margin',
  'revenue_one_year_growth_fy', 'earnings_per_share_forecast_next_fq',
];

const FIN_BALANCE_COLS = [
  'total_assets', 'total_current_assets', 'total_liabilities_net_minority_interest',
  'total_debt', 'net_debt', 'total_equity_gross_minority_interest',
  'cash_n_short_term_invest', 'accounts_receivable',
  'book_value_per_share_fq',
];

const FIN_CASHFLOW_COLS = [
  'cash_f_operating_activities_ttm', 'capital_expenditures_ttm',
  'free_cash_flow_ttm', 'cash_f_financing_activities_ttm',
  'cash_f_investing_activities_ttm',
];

const FIN_STATS_COLS = [
  'return_on_equity', 'return_on_assets', 'return_on_invested_capital',
  'debt_to_equity', 'current_ratio', 'quick_ratio',
  'gross_margin', 'operating_margin', 'net_margin', 'free_cash_flow_margin',
  'revenue_per_employee', 'after_tax_margin', 'pre_tax_margin',
  'asset_turnover', 'inventory_turnover',
  'beta_1_year', 'Volatility.D',
];

const FIN_DIVIDEND_COLS = [
  'dividend_yield_recent', 'dividends_per_share_fq', 'dividend_payout_ratio_ttm',
  'dividends_per_share_annual', 'dps_common_stock_prim_issue_yoy_growth_fy',
  'continuous_dividend_payout', 'continuous_dividend_growth',
  'ex_dividend_date_recent',
];

const FIN_EARNINGS_COLS = [
  'earnings_per_share_basic_ttm', 'earnings_per_share_diluted_ttm',
  'earnings_per_share_forecast_next_fq', 'earnings_per_share_fq',
  'revenue_per_share_ttm', 'total_revenue',
  'total_revenue_yoy_growth_ttm', 'net_income_yoy_growth_ttm',
  'earnings_release_next_date', 'earnings_release_date',
  'expected_annual_dividends',
  'after_tax_margin', 'pre_tax_margin',
  'number_of_analysts',
];

const SECTION_MAP = {
  overview:         FIN_OVERVIEW_COLS,
  income_statement: FIN_INCOME_COLS,
  balance_sheet:    FIN_BALANCE_COLS,
  cash_flow:        FIN_CASHFLOW_COLS,
  statistics:       FIN_STATS_COLS,
  dividends:        FIN_DIVIDEND_COLS,
  earnings:         FIN_EARNINGS_COLS,
};

export async function getFinancials({ symbol, section = 'overview' } = {}) {
  const info = await resolveSymbol(symbol);
  const cols = SECTION_MAP[section];
  if (!cols) {
    return {
      success: false,
      error: `Unknown section "${section}". Available: ${Object.keys(SECTION_MAP).join(', ')}`,
    };
  }

  const scan = await scannerFetch(info.full_name, cols, info.exchange, info.type);
  if (scan.error) return { success: false, symbol: info.full_name, section, error: scan.error };

  // Clean nulls out
  const data = {};
  for (const [k, v] of Object.entries(scan.data)) {
    if (v != null) data[k] = v;
  }

  return { success: true, symbol: info.full_name, section, source: 'scanner_api', data };
}

// ---------------------------------------------------------------------------
// 4. ETF Profile
// ---------------------------------------------------------------------------

const ETF_OVERVIEW_COLS = [
  'description', 'sector', 'industry',
  'market_cap_basic', 'average_volume_10d_calc', 'total_assets',
  'price_earnings_ttm', 'dividend_yield_recent', 'dividends_per_share_fq',
  'expense_ratio', 'net_asset_value', 'nav_discount_premium',
  'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y',
  'Volatility.D', 'Volatility.W', 'Volatility.M', 'beta_1_year',
  'number_of_holdings',
];

export async function getEtfProfile({ symbol, section = 'overview' } = {}) {
  const info = await resolveSymbol(symbol);

  if (section === 'overview') {
    const scan = await scannerFetch(info.full_name, ETF_OVERVIEW_COLS, info.exchange, info.type);
    if (scan.error) return { success: false, symbol: info.full_name, section, error: scan.error };
    const data = {};
    for (const [k, v] of Object.entries(scan.data)) {
      if (v != null) data[k] = v;
    }
    return { success: true, symbol: info.full_name, section, source: 'scanner_api', data };
  }

  if (section === 'holdings') {
    // Try to scrape holdings from TradingView's components page
    const holdings = await evaluateAsync(`
      (function() {
        var sym = ${JSON.stringify(info.full_name)}.replace(':', '-');
        return fetch('https://www.tradingview.com/symbols/' + sym + '/components/', {
          credentials: 'include',
          headers: {
            'Origin': 'https://www.tradingview.com',
            'Referer': 'https://www.tradingview.com/',
          }
        })
          .then(function(r) { if (!r.ok) return { error: 'HTTP ' + r.status }; return r.text(); })
          .then(function(html) {
            if (typeof html !== 'string') return html;
            // Parse holdings from page HTML — TV embeds JSON in data attributes or script tags
            var match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\\/script>/);
            if (match) {
              try {
                var json = JSON.parse(match[1]);
                // Navigate to component data
                var props = json.props && json.props.pageProps;
                if (props && props.components) return { holdings: props.components };
                if (props && props.holdings)   return { holdings: props.holdings };
                // Return keys for debugging
                return { keys: Object.keys(props || {}), partial: true };
              } catch(e) { return { error: 'JSON parse: ' + e.message }; }
            }
            // Fallback: try to find table rows
            var rows = [];
            var re = /<tr[^>]*>(.*?)<\\/tr>/gs;
            var m;
            var count = 0;
            while ((m = re.exec(html)) && count < 25) {
              var cells = m[1].match(/<td[^>]*>(.*?)<\\/td>/g);
              if (cells && cells.length >= 2) {
                var text = cells.map(function(c) { return c.replace(/<[^>]+>/g, '').trim(); });
                if (text[0]) rows.push(text);
                count++;
              }
            }
            if (rows.length) return { holdings: rows, source: 'html_table' };
            return { error: 'Could not parse holdings from page' };
          })
          .catch(function(e) { return { error: e.message }; });
      })()
    `);

    return {
      success: !holdings?.error,
      symbol: info.full_name,
      section: 'holdings',
      source: 'components_page',
      ...(holdings || {}),
    };
  }

  return { success: false, error: `Unknown section "${section}". Available: overview, holdings` };
}

// ---------------------------------------------------------------------------
// 5. Seasonals
// ---------------------------------------------------------------------------

/**
 * Compute seasonal monthly returns from OHLCV history.
 * Downloads up to 5 years of monthly bars and calculates average return per month.
 */
export async function getSeasonals({ symbol, years = 5 } = {}) {
  const info = await resolveSymbol(symbol);

  // Strategy 1: Try TradingView's seasonality endpoint
  const seasonData = await evaluateAsync(`
    (function() {
      var sym = encodeURIComponent(${JSON.stringify(info.full_name)});
      return fetch('https://www.tradingview.com/api/v1/symbols/' + sym + '/seasonality', {
        credentials: 'include',
        headers: {
          'Origin': 'https://www.tradingview.com',
          'Referer': 'https://www.tradingview.com/',
        }
      })
        .then(function(r) { if (!r.ok) return null; return r.json(); })
        .then(function(data) { return data; })
        .catch(function() { return null; });
    })()
  `);

  if (seasonData && !seasonData.error && (seasonData.monthly || seasonData.data)) {
    return {
      success: true,
      symbol: info.full_name,
      source: 'tradingview_api',
      data: seasonData.monthly || seasonData.data || seasonData,
    };
  }

  // Strategy 2: Compute from monthly bars via scanner performance columns
  const perfCols = [
    'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y',
    'Perf.5Y', 'Perf.All',
    'change|1M', 'change|3M', 'change|6M', 'change|12M',
    'High.1M', 'Low.1M', 'High.3M', 'Low.3M', 'High.6M', 'Low.6M',
    'High.1Y', 'Low.1Y',
  ];
  const scan = await scannerFetch(info.full_name, perfCols, info.exchange, info.type);

  // Strategy 3: Compute from chart OHLCV data (monthly bars)
  const monthlyReturns = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var bars = chart.model().mainSeries().bars();
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var end = bars.lastIndex();
        var start = bars.firstIndex();
        // Collect all bars with timestamps
        var all = [];
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) all.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4] });
        }
        if (all.length < 20) return null;

        // Group by month, compute monthly returns
        var monthBuckets = {};  // { month_num: [returns...] }
        var prevMonthClose = null;
        var prevMonth = -1;
        for (var bi = 0; bi < all.length; bi++) {
          var d = new Date(all[bi].time * 1000);
          var m = d.getMonth(); // 0-11
          var y = d.getFullYear();
          var key = y + '-' + m;
          if (!monthBuckets[key]) monthBuckets[key] = { month: m, year: y, first_open: all[bi].open, last_close: all[bi].close };
          monthBuckets[key].last_close = all[bi].close;
        }
        // Compute per-calendar-month averages
        var monthlyAvg = {};
        var names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        for (var mi = 0; mi < 12; mi++) monthlyAvg[names[mi]] = { returns: [], avg: 0, positive_pct: 0 };

        var keys = Object.keys(monthBuckets).sort();
        for (var ki = 1; ki < keys.length; ki++) {
          var cur = monthBuckets[keys[ki]];
          var prev = monthBuckets[keys[ki - 1]];
          if (prev.last_close > 0) {
            var ret = ((cur.last_close - prev.last_close) / prev.last_close) * 100;
            monthlyAvg[names[cur.month]].returns.push(Math.round(ret * 100) / 100);
          }
        }
        for (var mi = 0; mi < 12; mi++) {
          var rets = monthlyAvg[names[mi]].returns;
          if (rets.length > 0) {
            monthlyAvg[names[mi]].avg = Math.round((rets.reduce(function(a,b){return a+b;},0) / rets.length) * 100) / 100;
            monthlyAvg[names[mi]].positive_pct = Math.round((rets.filter(function(r){return r>0;}).length / rets.length) * 100);
            monthlyAvg[names[mi]].sample_years = rets.length;
          }
          delete monthlyAvg[names[mi]].returns;
        }
        return monthlyAvg;
      } catch(e) { return null; }
    })()
  `);

  const result = {
    success: true,
    symbol: info.full_name,
    source: 'computed',
  };

  if (monthlyReturns) {
    result.monthly_seasonals = monthlyReturns;
  }

  if (scan && scan.data) {
    const perf = {};
    for (const [k, v] of Object.entries(scan.data)) {
      if (v != null) perf[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v;
    }
    result.performance = perf;
  }

  if (!monthlyReturns && (!scan || scan.error)) {
    return { success: false, symbol: info.full_name, error: 'Could not compute seasonals. Chart may need more history or a lower timeframe.' };
  }

  return result;
}
