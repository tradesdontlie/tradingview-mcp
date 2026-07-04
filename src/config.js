/**
 * Configuration loader for TradingView MCP
 * Reads environment variables for CDP configuration
 */

export function getConfig() {
  return {
    cdp: {
      host: process.env.CDP_HOST || 'localhost',
      port: parseInt(process.env.CDP_PORT || '9222', 10),
    },
  };
}
