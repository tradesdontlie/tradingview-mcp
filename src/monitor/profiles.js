import { TIERS } from './contracts.js';

const base = {
  context: [], setup: [], trigger: [], session: { timezone: 'UTC', sessions: [] }, volume: 'unknown',
};
export const VN_STOCK_PROFILE_V1 = Object.freeze({
  version: 'vn-stock.v1', asset_class: 'VN_STOCK', timezone: 'Asia/Ho_Chi_Minh',
  session: { version: 'vn-session.v1', timezone: 'Asia/Ho_Chi_Minh', sessions: ['ATO', 'EARLY', 'CONT_AM', 'LUNCH', 'CONT_PM', 'ATC', 'CLOSED'], holidays: 'VN', gap_rule: 'exchange' },
  volume: { semantics: 'exchange', required: true }, defaults: { context: ['D'], setup: ['360', '60'], trigger: ['60'] }, tiers: TIERS,
});
export const XAUUSD_PROFILE_V1 = Object.freeze({
  version: 'xauusd.v1', asset_class: 'XAUUSD', timezone: 'UTC',
  session: { version: 'xau-session.v1', timezone: 'UTC', sessions: [], maintenance: 'daily', spread_rule: 'required' },
  volume: { semantics: 'tick', required: false }, defaults: { context: ['60', '240'], setup: ['15'], trigger: ['5', '15'] }, tiers: TIERS,
});

const PROFILES = {
  VN_STOCK: VN_STOCK_PROFILE_V1, XAUUSD: XAUUSD_PROFILE_V1, vn_stock: VN_STOCK_PROFILE_V1, xauusd: XAUUSD_PROFILE_V1,
  'vn-stock.v1': VN_STOCK_PROFILE_V1, 'xauusd.v1': XAUUSD_PROFILE_V1,
  VN_STOCK_PROFILE_V1, XAUUSD_PROFILE_V1,
};

export function getProfile(name) {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`PROFILE_UNKNOWN:${name}`);
  return profile;
}

export function resolveWatchItem(item = {}) {
  const profile = getProfile(item.asset_class ?? item.profile);
  const tier = item.tier ?? 'DISCOVERY';
  if (!TIERS.includes(tier)) throw new Error(`TIER_UNKNOWN:${tier}`);
  const merged = { ...base, ...item, profile: profile.version, policy_version: item.policy_version ?? profile.session.version, tier, sessionPolicy: item.sessionPolicy ?? profile.session, defaults: item.defaults ?? profile.defaults };
  if (tier === 'CONTEXT') merged.alerts = false;
  return Object.freeze(merged);
}

export function canAlert(item) { return resolveWatchItem(item).tier !== 'CONTEXT'; }
