// Bitcoin Market Pulse — ported from atilaahmettaner/bitcoin_market_service.py
// Single-call macro context for crypto decisions: price + dominance + risk label.
// Source: CoinGecko public API. Free, no key.

const TIMEOUT_MS = 10_000;
const UA = 'tradingview-mcp/0.8.0';
const GLOBAL_URL = 'https://api.coingecko.com/api/v3/global';
const PRICE_URL =
  'https://api.coingecko.com/api/v3/simple/price' +
  '?ids=bitcoin&vs_currencies=usd' +
  '&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true';

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function classifyRisk(btcChange24h, btcDominance, totalMcapChange24h) {
  const btcVolatile = Math.abs(btcChange24h) > 5;
  const domHigh = btcDominance > 55;
  const domLow = btcDominance < 45;

  if (btcVolatile && btcChange24h < 0) {
    return [
      'HIGH_RISK',
      `BTC is down ${btcChange24h.toFixed(1)}% in 24h — meaningful move, not noise. ` +
        `Dominance at ${btcDominance.toFixed(1)}% means alts likely bleeding harder. ` +
        `Total crypto market cap ${totalMcapChange24h >= 0 ? '+' : ''}${totalMcapChange24h.toFixed(1)}% on the day. ` +
        'Tight stops or sit-out on alt entries until BTC stabilizes.',
    ];
  }
  if (btcVolatile && btcChange24h > 0) {
    const rotation = domHigh
      ? 'BTC is leading, alts may lag this leg.'
      : domLow
      ? 'alts probably ripping harder — late-bull behavior.'
      : 'balanced rotation, both moving together.';
    return [
      'OPPORTUNITY_WITH_CAUTION',
      `BTC is up ${btcChange24h.toFixed(1)}% in 24h — strong move. ` +
        `Dominance at ${btcDominance.toFixed(1)}%: ${rotation} ` +
        `Total market cap ${totalMcapChange24h >= 0 ? '+' : ''}${totalMcapChange24h.toFixed(1)}%.`,
    ];
  }
  if (domHigh && btcChange24h < -1.5) {
    return [
      'ALT_RISK',
      `BTC dominance high (${btcDominance.toFixed(1)}%) AND BTC soft ` +
        `(${btcChange24h >= 0 ? '+' : ''}${btcChange24h.toFixed(1)}%/24h) — ` +
        'worst combo for altcoins. Capital is in BTC and BTC isn\'t holding.',
    ];
  }
  if (domLow && btcChange24h > 1.5) {
    return [
      'ALT_FAVORABLE',
      `BTC dominance low (${btcDominance.toFixed(1)}%) and BTC up ` +
        `+${btcChange24h.toFixed(1)}% — capital-rotation-into-alts pattern. ` +
        'Macro permissive for strong alt setups.',
    ];
  }
  return [
    'NEUTRAL',
    `BTC ${btcChange24h >= 0 ? '+' : ''}${btcChange24h.toFixed(1)}%/24h, ` +
      `dominance ${btcDominance.toFixed(1)}%, ` +
      `total mcap ${totalMcapChange24h >= 0 ? '+' : ''}${totalMcapChange24h.toFixed(1)}%. ` +
      'No strong directional signal — individual setups carry most of the weight.',
  ];
}

export async function getBitcoinMarketPulse() {
  const base = { source: 'CoinGecko', tool: 'bitcoin_market_pulse' };

  let dominance, ethDominance, totalMcapUsd, totalMcapChange24h, activeCryptos;
  try {
    const g = (await fetchJson(GLOBAL_URL)).data || {};
    dominance = g.market_cap_percentage?.btc;
    ethDominance = g.market_cap_percentage?.eth;
    totalMcapUsd = g.total_market_cap?.usd;
    totalMcapChange24h = g.market_cap_change_percentage_24h_usd;
    activeCryptos = g.active_cryptocurrencies;
  } catch (e) {
    return { ...base, error: `global fetch failed: ${e.message}` };
  }

  let btcPrice, btcChange24h, btcVolume24h, btcMarketCap;
  try {
    const p = (await fetchJson(PRICE_URL)).bitcoin || {};
    btcPrice = p.usd;
    btcChange24h = p.usd_24h_change;
    btcVolume24h = p.usd_24h_vol;
    btcMarketCap = p.usd_market_cap;
  } catch (e) {
    return { ...base, error: `price fetch failed: ${e.message}` };
  }

  let label = 'UNKNOWN';
  let summary = 'Some metrics missing; cannot classify.';
  if ([btcChange24h, dominance, totalMcapChange24h].every(v => v != null)) {
    [label, summary] = classifyRisk(btcChange24h, dominance, totalMcapChange24h);
  }

  return {
    ...base,
    bitcoin: {
      price_usd: btcPrice,
      change_24h_pct: btcChange24h,
      volume_24h_usd: btcVolume24h,
      market_cap_usd: btcMarketCap,
    },
    dominance: { btc_pct: dominance, eth_pct: ethDominance },
    total_market: {
      market_cap_usd: totalMcapUsd,
      change_24h_pct: totalMcapChange24h,
      active_cryptocurrencies: activeCryptos,
    },
    assessment: { label, summary },
  };
}
