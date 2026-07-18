const DEFAULT_DESCRIPTION = 'Local MCP bridge for TradingView Desktop and read-only NinjaTrader TradingBridge snapshots';

export function getBranding(env = process.env) {
  const displayName = env.APP_DISPLAY_NAME?.trim() || 'NinjaView';
  const codename = env.APP_CODENAME?.trim() || 'ninjaview';
  if (!/^[a-z][a-z0-9-]*$/.test(codename)) {
    throw new Error('APP_CODENAME must be a lowercase slug beginning with a letter');
  }

  return {
    displayName,
    codename,
    mcpServerName: `${codename}-bridge`,
    description: DEFAULT_DESCRIPTION,
  };
}
