// Phase 2C.1 — IBKR Client Portal market-input provider. READ-ONLY.
// Pure parsing functions (no I/O) are exported separately from the
// network-touching orchestration function, per Step 17's "pure normalized
// market-input code must NOT know HTTP routes" — the parsers here know
// nothing about HTTP; only ibkrMarketInputs() below calls the injected
// clientPortalClient.

export const IBKR_FIELDS = Object.freeze({
  SHORTABLE_SHARES: '7636',
  FEE_RATE: '7637',
  SHORTABLE: '7644',
  DIVIDENDS_12M: '7671',
  MARKET_DATA_AVAILABILITY: '6509',
});

export const CONNECTION_STATUS = Object.freeze({ CONNECTED: 'CONNECTED', AUTH_REQUIRED: 'AUTH_REQUIRED', UNAVAILABLE: 'UNAVAILABLE' });

// --- Step 8: Fee Rate parsing ------------------------------------------------

/**
 * Parses IBKR's Fee Rate field into a decimal (e.g. "0.25%" -> 0.0025).
 * Never confuses a genuine reported 0 with missing data — returns
 * { value: 0, present: true } for an explicit zero, and
 * { value: null, present: false } for null/undefined/empty/"N/A"/garbage.
 */
export function parseIbkrFeeRate(raw) {
  if (raw == null) return { value: null, present: false };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.toUpperCase() === 'N/A') return { value: null, present: false };
    const isPercent = trimmed.endsWith('%');
    const numeric = Number(isPercent ? trimmed.slice(0, -1) : trimmed);
    if (!Number.isFinite(numeric)) return { value: null, present: false };
    return { value: isPercent ? numeric / 100 : numeric / 100, present: true }; // IBKR Fee Rate is quoted as a percentage number either way
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { value: null, present: false };
    return { value: raw / 100, present: true }; // numeric field is also a percentage points value (e.g. 0.25 => 0.25%)
  }
  return { value: null, present: false };
}

// --- Step 12-13: forward dividend parsing -----------------------------------

/**
 * Parses IBKR field 7671 (expected 12m dividends per share). Distinguishes
 * an explicit reported zero (FORWARD_DIVIDEND_ZERO_REPORTED) from missing
 * data — Step 13 requires this NOT be silently promoted to
 * ZERO_DIVIDEND_CONFIRMED without separate corroboration.
 */
export function parseIbkrExpectedDividend(raw) {
  if (raw == null) return { value: null, present: false };
  const numeric = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (!Number.isFinite(numeric)) return { value: null, present: false };
  return { value: numeric, present: true };
}

// --- Step 6: market-data availability normalization --------------------------

const AVAILABILITY_CODE_MAP = Object.freeze({
  R: 'REALTIME', D: 'DELAYED', Z: 'FROZEN', N: 'NOT_SUBSCRIBED', P: 'INCOMPLETE',
});

/**
 * IBKR's 6509 field is documented as a short code string (possibly
 * multi-character, e.g. combining a data-source and a state indicator).
 * This normalizes the leading known code and preserves the raw value
 * for diagnostics — never claims REALTIME for anything not explicitly
 * matched.
 */
export function normalizeMarketDataAvailability(raw) {
  if (raw == null || raw === '') return { normalized: 'UNKNOWN', raw };
  const code = String(raw).trim().charAt(0).toUpperCase();
  return { normalized: AVAILABILITY_CODE_MAP[code] ?? 'UNKNOWN', raw };
}

// --- Step 11: shortable diagnostics -----------------------------------------

export function classifyShortableStatus({ shortableShares, shortableCode }) {
  if (shortableCode === '2' || (typeof shortableShares === 'number' && shortableShares > 0)) return 'BORROW_AVAILABLE';
  if (shortableCode === '1' || shortableCode === '0') return 'BORROW_CONSTRAINED';
  return 'BORROW_STATUS_UNKNOWN';
}

// --- Step 3-7: orchestration (network-touching) ------------------------------

/**
 * Step 3 — read-only connection/auth status probe. Never throws; pricing
 * modules must be able to continue with missing borrow data on any
 * failure mode.
 */
export async function probeIbkrConnection(client) {
  const res = await client.getAuthStatus();
  if (!res.ok) {
    if (res.error === 'TIMEOUT' || res.error === 'NETWORK_ERROR') return { status: CONNECTION_STATUS.UNAVAILABLE, detail: res.error };
    return { status: CONNECTION_STATUS.UNAVAILABLE, detail: `HTTP_${res.status}` };
  }
  if (res.body?.authenticated === true) return { status: CONNECTION_STATUS.CONNECTED, detail: null };
  return { status: CONNECTION_STATUS.AUTH_REQUIRED, detail: res.body?.message ?? 'NOT_AUTHENTICATED' };
}

/**
 * Step 4 — resolves an equity symbol to an IBKR conid via the stock
 * search route. In-memory cache only (per Step 4: "do not persist
 * account-sensitive information" — a conid isn't account-sensitive, but
 * we still don't write it to disk). Validates secType === 'STK' so an
 * option conid is never accidentally used for equity borrow information.
 */
export function makeConidResolver(client) {
  const cache = new Map();
  return async function resolveConid(symbol) {
    if (cache.has(symbol)) return cache.get(symbol);
    const res = await client.searchStock(symbol);
    if (!res.ok || !Array.isArray(res.body)) return { conid: null, error: 'LOOKUP_FAILED' };
    const stockMatch = res.body.find(r => r.symbol === symbol && (r.secType === 'STK' || r.sections?.some(s => s.secType === 'STK')));
    if (!stockMatch) return { conid: null, error: 'NO_STOCK_MATCH' };
    const result = { conid: stockMatch.conid, symbol: stockMatch.symbol, currency: stockMatch.currency ?? null, exchange: stockMatch.listingExchange ?? stockMatch.exchange ?? null };
    cache.set(symbol, result);
    return result;
  };
}

/**
 * Step 5 — snapshot preflight: IBKR's first snapshot call after a
 * conid/field combo hasn't been "warmed up" often returns an empty/
 * partial payload; this is NOT treated as missing data. Retries
 * synchronously up to maxAttempts with a short deterministic delay,
 * stopping as soon as all requested fields are present. No background
 * polling.
 */
export async function snapshotWithPreflight(client, conid, fields, { maxAttempts = 5, delayMs = 250, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  let lastBody = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await client.getSnapshot(conid, fields);
    if (res.ok && Array.isArray(res.body) && res.body[0]) {
      lastBody = res.body[0];
      const hasAllFields = fields.every(f => lastBody[f] !== undefined);
      if (hasAllFields) return { data: lastBody, attempts: attempt, complete: true };
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return { data: lastBody, attempts: maxAttempts, complete: false };
}

/**
 * Full orchestration: connection -> conid -> snapshot preflight ->
 * normalized IBKR market-input result. Never throws on connectivity
 * failure — returns a structured UNAVAILABLE/AUTH_REQUIRED result so
 * callers (productionMarketInputs.js) can fall back cleanly.
 */
export async function fetchIbkrMarketInputs(client, symbol) {
  const asOfUtc = new Date().toISOString();
  const connection = await probeIbkrConnection(client);
  if (connection.status !== CONNECTION_STATUS.CONNECTED) {
    return { symbol, connection_status: connection.status, connection_detail: connection.detail, as_of_utc: asOfUtc, fee_rate: null, expected_12m_dividend_per_share: null, shortable_status: 'BORROW_STATUS_UNKNOWN', market_data_availability: 'UNKNOWN', warnings: [connection.status === CONNECTION_STATUS.AUTH_REQUIRED ? 'IBKR_AUTH_REQUIRED' : 'IBKR_UNAVAILABLE'] };
  }

  const resolveConid = makeConidResolver(client);
  const conidResult = await resolveConid(symbol);
  if (conidResult.conid == null) {
    return { symbol, connection_status: connection.status, connection_detail: conidResult.error, as_of_utc: asOfUtc, fee_rate: null, expected_12m_dividend_per_share: null, shortable_status: 'BORROW_STATUS_UNKNOWN', market_data_availability: 'UNKNOWN', warnings: ['IBKR_CONID_LOOKUP_FAILED'] };
  }

  const fields = [IBKR_FIELDS.SHORTABLE_SHARES, IBKR_FIELDS.FEE_RATE, IBKR_FIELDS.SHORTABLE, IBKR_FIELDS.DIVIDENDS_12M, IBKR_FIELDS.MARKET_DATA_AVAILABILITY];
  const snapshot = await snapshotWithPreflight(client, conidResult.conid, fields);
  const data = snapshot.data ?? {};

  const feeRate = parseIbkrFeeRate(data[IBKR_FIELDS.FEE_RATE]);
  const dividend = parseIbkrExpectedDividend(data[IBKR_FIELDS.DIVIDENDS_12M]);
  const availability = normalizeMarketDataAvailability(data[IBKR_FIELDS.MARKET_DATA_AVAILABILITY]);
  const shortableShares = data[IBKR_FIELDS.SHORTABLE_SHARES] != null ? Number(data[IBKR_FIELDS.SHORTABLE_SHARES]) : null;
  const shortableStatus = classifyShortableStatus({ shortableShares, shortableCode: data[IBKR_FIELDS.SHORTABLE] });

  const warnings = [];
  if (!snapshot.complete) warnings.push('IBKR_SNAPSHOT_INCOMPLETE');
  if (!feeRate.present) warnings.push('IBKR_FEE_RATE_UNAVAILABLE');
  if (!dividend.present) warnings.push('IBKR_DIVIDEND_UNAVAILABLE');
  if (dividend.present && dividend.value === 0) warnings.push('FORWARD_DIVIDEND_ZERO_REPORTED');
  if (availability.normalized !== 'REALTIME') warnings.push('IBKR_MARKET_DATA_NOT_REALTIME');

  return {
    symbol, connection_status: connection.status, conid: conidResult.conid,
    as_of_utc: asOfUtc, ibkr_snapshot_as_of_utc: data._updated ?? null,
    fee_rate: feeRate.value, fee_rate_present: feeRate.present,
    expected_12m_dividend_per_share: dividend.value, dividend_present: dividend.present,
    shortable_shares: shortableShares, shortable_status: shortableStatus,
    market_data_availability: availability.normalized, market_data_availability_raw: availability.raw,
    warnings,
  };
}
