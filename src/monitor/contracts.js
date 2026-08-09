import crypto from 'node:crypto';

export const MONITOR_SCHEMA_VERSION = 'monitor.v1';
export const ENGINE_VERSION = 'monitor-engine.v1';
export const STATUS = Object.freeze({ CANDIDATE: 'CANDIDATE', PROVISIONAL: 'PROVISIONAL', CONFIRMED: 'CONFIRMED', RETRACTED: 'RETRACTED', EXPIRED: 'EXPIRED' });
export const DATA_QUALITY = Object.freeze({ UNKNOWN: 'UNKNOWN', STALE: 'STALE' });
export const FRESHNESS = Object.freeze(['FRESH', 'UNKNOWN', 'STALE']);
export const DIRECTIONS = Object.freeze(['BULLISH', 'BEARISH']);
export const EVIDENCE_FAMILIES = Object.freeze(['levels', 'structure', 'indicators', 'volume']);
export const TIERS = Object.freeze(['CORE', 'TACTICAL', 'DISCOVERY', 'CONTEXT']);
export const ALLOWED_STATUSES = new Set(Object.values(STATUS));

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return value === undefined ? 'null' : JSON.stringify(value);
}

export function canonicalIdentity(identity = {}) {
  const out = {
    provider: identity.provider,
    exchange: identity.exchange,
    symbol: identity.symbol,
    full_symbol: identity.full_symbol ?? identity.fullSymbol ?? identity.symbol_identity,
    timeframe: String(identity.timeframe ?? ''),
    pane: identity.pane,
    layout: identity.layout,
    profile: identity.profile,
  };
  return out;
}

export function identityKey(identity) { return canonicalJson(canonicalIdentity(identity)); }

export function validateIdentity(identity, { requireProfile = true } = {}) {
  const i = canonicalIdentity(identity);
  const required = ['provider', 'exchange', 'full_symbol', 'timeframe', 'pane', 'layout'];
  if (requireProfile) required.push('profile');
  for (const key of required) if (typeof i[key] !== 'string' || !i[key].trim()) throw new Error(`IDENTITY_MISSING:${key}`);
  if (typeof i.symbol !== 'string' || !i.symbol.trim()) throw new Error('IDENTITY_MISSING:symbol');
  return i;
}

export function assertIdentityMatch(expected, observed) {
  const a = validateIdentity(expected); const b = validateIdentity(observed);
  if (identityKey(a) !== identityKey(b)) throw new Error('IDENTITY_MISMATCH');
  return b;
}

export function canonicalBarKey({ symbol_identity, identity, timeframe, session, bar_open_timestamp, bar_index }) {
  const sid = typeof symbol_identity === 'string' ? symbol_identity : identityKey(identity ?? {});
  if (!sid || timeframe == null || session == null || bar_open_timestamp == null || bar_index == null) throw new Error('BAR_KEY_MISSING');
  return [sid, String(timeframe), String(session), String(bar_open_timestamp), String(bar_index)].join('|');
}

export function serializeEvidence(evidence = []) {
  return [...evidence].map(item => ({ ...item })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
}

export function evidenceHash(evidence = []) { return crypto.createHash('sha256').update(canonicalJson(serializeEvidence(evidence))).digest('hex'); }

export function validateEvidence(item, { barKey } = {}) {
  if (!item || !EVIDENCE_FAMILIES.includes(item.family)) throw new Error('EVIDENCE_INVALID_FAMILY');
  if (!item.bar_key || !(item.source_id ?? item.source_tool ?? item.source_study_id) || !item.config_version || !item.policy_version || !item.profile || !item.session || !FRESHNESS.includes(item.freshness) || !DIRECTIONS.includes(item.direction) || (item.canonical_value === undefined && item.value === undefined)) throw new Error('EVIDENCE_MISSING_PROVENANCE');
  if (barKey && item.bar_key !== barKey) throw new Error('EVIDENCE_BAR_MISMATCH');
  return item;
}

export function validateStatus(status) { if (!ALLOWED_STATUSES.has(status)) throw new Error(`STATUS_INVALID:${status}`); return status; }
