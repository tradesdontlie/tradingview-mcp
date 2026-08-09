import { canonicalBarKey, canonicalIdentity, canonicalJson, DATA_QUALITY, STATUS, validateIdentity } from './contracts.js';

const ms = value => value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number(value);

export function normalizeObservation(raw = {}, { expectedIdentity, now = Date.now(), sessionPolicy = {}, previousObservation = null } = {}) {
  const identity = validateIdentity(canonicalIdentity(raw.identity ?? raw));
  const expected = expectedIdentity ? validateIdentity(expectedIdentity) : identity;
  if (JSON.stringify(identity) !== JSON.stringify(expected)) return { accepted: false, reason: 'IDENTITY_MISMATCH', quality: DATA_QUALITY.UNKNOWN };
  const source = ms(raw.source_timestamp ?? raw.sourceTimestamp ?? raw.timestamp ?? raw.bar_open_timestamp);
  const receipt = ms(raw.receipt_timestamp ?? raw.receiptTimestamp ?? now);
  const evaluated = ms(raw.evaluated_at ?? raw.evaluatedAt ?? now);
  if (![source, receipt, evaluated].every(Number.isFinite)) return { accepted: false, reason: 'TIMESTAMP_INVALID', quality: DATA_QUALITY.UNKNOWN };
  const skewMs = Number(sessionPolicy.clockSkewMs ?? 120000);
  if (source > now + skewMs || receipt > now + skewMs || evaluated > now + skewMs) return { accepted: false, reason: 'FUTURE_TIMESTAMP', quality: DATA_QUALITY.UNKNOWN };
  if (Math.abs(receipt - source) > Number(sessionPolicy.maxClockSkewMs ?? 86_400_000)) return { accepted: false, reason: 'CLOCK_SKEW', quality: DATA_QUALITY.UNKNOWN };
  const barOpen = ms(raw.bar_open_timestamp ?? raw.barOpenTimestamp ?? source);
  const index = Number(raw.bar_index ?? raw.barIndex ?? 0);
  if (!sessionPolicy.version || !Array.isArray(sessionPolicy.sessions) || sessionPolicy.sessions.length === 0 || typeof raw.session !== 'string' || !raw.session.trim()) return { accepted: false, reason: 'SESSION_POLICY_INVALID', quality: DATA_QUALITY.UNKNOWN };
  if (!sessionPolicy.sessions.includes(raw.session)) return { accepted: false, reason: 'SESSION_OUT_OF_POLICY', quality: DATA_QUALITY.UNKNOWN };
  const session = raw.session;
  const barKey = canonicalBarKey({ identity, timeframe: raw.timeframe ?? identity.timeframe, session, bar_open_timestamp: barOpen, bar_index: index });
  const fingerprint = canonicalJson({ values: raw.values ?? raw, source, receipt, evaluated, closed: Boolean(raw.bar_closed ?? raw.barClosed ?? raw.closed ?? false) });
  if (previousObservation) {
    if (previousObservation.bar_key === barKey && previousObservation.fingerprint === fingerprint) return { accepted: false, reason: 'DUPLICATE', quality: DATA_QUALITY.UNKNOWN, bar_key: barKey };
    if (Number.isFinite(previousObservation.bar_open_timestamp) && barOpen < previousObservation.bar_open_timestamp) return { accepted: false, reason: 'OUT_OF_ORDER', quality: DATA_QUALITY.UNKNOWN, bar_key: barKey };
  }
  const staleMs = Number(sessionPolicy.staleMs ?? 300000);
  const quality = now - source > staleMs ? DATA_QUALITY.STALE : 'FRESH';
  const closed = Boolean(raw.bar_closed ?? raw.barClosed ?? raw.closed ?? false);
  const kind = raw.kind ?? raw.type ?? 'bar';
  const status = kind === 'quote' || kind === 'tick' || !closed ? STATUS.PROVISIONAL : STATUS.CANDIDATE;
  return Object.freeze({ accepted: quality !== DATA_QUALITY.STALE, reason: quality === DATA_QUALITY.STALE ? 'STALE' : null, quality, identity, symbol_identity: JSON.stringify(identity), timeframe: raw.timeframe ?? identity.timeframe, session, policy_version: sessionPolicy.version, bar_open_timestamp: barOpen, bar_index: index, bar_key: barKey, source_timestamp: source, receipt_timestamp: receipt, evaluated_at: evaluated, bar_closed: closed, status, kind, fingerprint, missing_stale: raw.missing_stale ?? [], values: raw.values ?? raw });
}
