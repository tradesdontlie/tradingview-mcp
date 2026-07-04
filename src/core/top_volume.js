import https from 'node:https';

// Stablecoin/tokenized-asset bases that trade nearly flat against USDT —
// excluded from top-volume selection since their "win rates" are noise.
export const STABLE_BASES = new Set([
  'USDC', 'USD1', 'FDUSD', 'TUSD', 'DAI', 'EUR', 'GBP', 'XAUT', 'PAXG', 'USDP', 'EURI',
]);

// Top-N USDT pairs by 24h quote volume (mainnet ticker, no auth — testnet has
// no market-wide ticker endpoint).
export function fetchTopVolumeSymbols(count) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.binance.com',
      path: '/api/v3/ticker/24hr',
      agent: false,
      headers: { 'User-Agent': 'tradingview-mcp-bot/1.0' },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const symbols = JSON.parse(data)
            .filter(d => d.symbol.endsWith('USDT'))
            .filter(d => !STABLE_BASES.has(d.symbol.slice(0, -4)))
            .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
            .slice(0, count)
            .map(d => d.symbol);
          resolve(symbols);
        } catch (e) { reject(new Error(`Parse error: ${e.message} — body: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}
