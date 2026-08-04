import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function jsonResult(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

const server = new McpServer(
  {
    name: 'onchain',
    version: '1.0.0',
    description: 'Free, no-API-key crypto market and on-chain data (CoinGecko + DefiLlama)',
  },
  {
    instructions: `On-chain / crypto market data tools:
- get_crypto_price → quick spot price for one or more coins
- get_market_data → price, 24h change, market cap, volume for one or more coins
- get_trending_coins → top coins trending on CoinGecko right now
- get_chain_tvl → historical Total Value Locked for an entire chain (e.g. "ethereum", "solana")
- get_protocol_tvl → current + historical TVL for a specific DeFi protocol (e.g. "aave", "uniswap")

Use CoinGecko coin ids (lowercase, e.g. "bitcoin", "ethereum", "solana"), not ticker symbols.`,
  }
);

server.tool(
  'get_crypto_price',
  'Get current spot price for one or more coins from CoinGecko',
  {
    ids: z.string().describe('Comma-separated CoinGecko coin ids, e.g. "bitcoin,ethereum,solana"'),
    vs_currency: z.string().optional().describe('Currency to price in (default "usd")'),
  },
  async ({ ids, vs_currency }) => {
    try {
      const currency = vs_currency || 'usd';
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=${encodeURIComponent(currency)}&include_24hr_change=true`;
      return jsonResult(await fetchJson(url));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  }
);

server.tool(
  'get_market_data',
  'Get price, 24h change, market cap, and volume for one or more coins',
  {
    ids: z.string().describe('Comma-separated CoinGecko coin ids, e.g. "bitcoin,ethereum"'),
    vs_currency: z.string().optional().describe('Currency to price in (default "usd")'),
  },
  async ({ ids, vs_currency }) => {
    try {
      const currency = vs_currency || 'usd';
      const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=${encodeURIComponent(currency)}&ids=${encodeURIComponent(ids)}&order=market_cap_desc&price_change_percentage=24h`;
      return jsonResult(await fetchJson(url));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  }
);

server.tool(
  'get_trending_coins',
  'Get the coins currently trending on CoinGecko (by search volume)',
  {},
  async () => {
    try {
      const data = await fetchJson('https://api.coingecko.com/api/v3/search/trending');
      const coins = (data.coins || []).map(({ item }) => ({
        id: item.id,
        symbol: item.symbol,
        name: item.name,
        market_cap_rank: item.market_cap_rank,
        price_usd: item.data?.price,
        price_change_24h_pct: item.data?.price_change_percentage_24h?.usd,
      }));
      return jsonResult({ coins });
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  }
);

server.tool(
  'get_chain_tvl',
  'Get historical Total Value Locked (TVL) for an entire chain via DefiLlama',
  {
    chain: z.string().describe('Chain slug, e.g. "ethereum", "solana", "arbitrum"'),
  },
  async ({ chain }) => {
    try {
      const url = `https://api.llama.fi/v2/historicalChainTvl/${encodeURIComponent(chain)}`;
      const data = await fetchJson(url);
      const last = Array.isArray(data) ? data.slice(-5) : data;
      return jsonResult({ chain, recent: last });
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  }
);

server.tool(
  'get_protocol_tvl',
  'Get current and historical TVL for a specific DeFi protocol via DefiLlama',
  {
    protocol: z.string().describe('DefiLlama protocol slug, e.g. "aave", "uniswap", "lido"'),
  },
  async ({ protocol }) => {
    try {
      const url = `https://api.llama.fi/protocol/${encodeURIComponent(protocol)}`;
      const data = await fetchJson(url);
      return jsonResult({
        name: data.name,
        symbol: data.symbol,
        chain: data.chain,
        currentTvl: data.currentChainTvls,
        chainTvls: Object.keys(data.chainTvls || {}),
      });
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
