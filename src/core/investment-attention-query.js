import {
  DEFAULT_ATTENTION_STATE_DIR,
} from './investment-attention-config.js';
import {
  openInvestmentAttentionLedger,
} from './investment-attention-ledger.js';

export const INVESTMENT_ATTENTION_QUERY_SCHEMA_VERSION = 'investment-attention-query/v1';

const FAMILY_ALIASES = new Map([
  ['sma', 'sma_fib'],
  ['fib', 'sma_fib'],
  ['sma_fib', 'sma_fib'],
  ['rsi', 'rsi'],
  ['cup', 'cup_and_handle'],
  ['cup_and_handle', 'cup_and_handle'],
]);

function normalizeFamily(value) {
  if (value === undefined || value === null) return undefined;
  const result = FAMILY_ALIASES.get(String(value).trim().toLowerCase());
  if (!result) throw new TypeError(`unsupported attention family: ${value}`);
  return result;
}
/**
 * Read the durable four-family attention state. This function is intentionally
 * side-effect free: querying an unchanged revision never emits a notification.
 */
export function queryInvestmentAttention({
  stateDir = DEFAULT_ATTENTION_STATE_DIR,
  symbol,
  timeframe,
  family,
  sinceRevision,
} = {}) {
  const ledger = openInvestmentAttentionLedger({ stateDir });
  const result = ledger.query({
    symbol,
    timeframe,
    family: normalizeFamily(family),
    sinceRevision,
  });
  return {
    ...result,
    schema_version: INVESTMENT_ATTENTION_QUERY_SCHEMA_VERSION,
    family_filter: normalizeFamily(family) ?? null,
    query: {
      symbol: symbol ?? null,
      timeframe: timeframe ?? null,
      family: normalizeFamily(family) ?? null,
      since_revision: sinceRevision ?? null,
    },
    current_lifecycle: result.current_lifecycle,
    latest_event: result.latest_events
      .map(route => route.latest_event)
      .filter(Boolean)
      .sort((left, right) => (right.observed_at ?? '').localeCompare(left.observed_at ?? ''))[0] ?? null,
  };
}
