export const ARBITRARY_PAGE_JS_ENV = 'TRADINGVIEW_MCP_ALLOW_ARBITRARY_PAGE_JS';
export const ARBITRARY_PAGE_JS_ACK = 'I_UNDERSTAND_THIS_EXECUTES_ARBITRARY_JAVASCRIPT';
export const REPLAY_TRADING_ENV = 'TRADINGVIEW_MCP_ALLOW_REPLAY_TRADES';
export const REPLAY_TRADING_ACK = 'I_UNDERSTAND_THIS_CHANGES_SIMULATED_REPLAY_POSITIONS';
export const SELF_UPDATE_ENV = 'TRADINGVIEW_MCP_ALLOW_SELF_UPDATE';
export const SELF_UPDATE_ACK = 'I_UNDERSTAND_THIS_PULLS_AND_RUNS_REMOTE_CODE';

export function requireArbitraryPageJs(env = process.env) {
  if (env[ARBITRARY_PAGE_JS_ENV] !== ARBITRARY_PAGE_JS_ACK) {
    throw new Error(
      `Arbitrary page JavaScript is disabled. To deliberately enable ui_evaluate, set ${ARBITRARY_PAGE_JS_ENV}=${ARBITRARY_PAGE_JS_ACK} when starting the MCP server or CLI.`,
    );
  }
}

export function requireReplayTrading(env = process.env) {
  if (env[REPLAY_TRADING_ENV] !== REPLAY_TRADING_ACK) {
    throw new Error(
      `Simulated Replay trades are disabled. To deliberately enable replay_trade, set ${REPLAY_TRADING_ENV}=${REPLAY_TRADING_ACK} when starting the MCP server or CLI.`,
    );
  }
}

export function requireSelfUpdate(env = process.env) {
  if (env[SELF_UPDATE_ENV] !== SELF_UPDATE_ACK) {
    throw new Error(
      `Self-update is disabled. tv_update pulls origin/main and runs npm ci, executing remote code. To deliberately enable it, set ${SELF_UPDATE_ENV}=${SELF_UPDATE_ACK} when starting the MCP server or CLI.`,
    );
  }
}
