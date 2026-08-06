/**
 * bar_status.mjs — nen hien tai DA DONG hay CHUA + da song bao nhieu %.
 * Chong loi doc nen D-0 chua dong nhu da chot (vong luan quan entry dau phien).
 * Dung chung check_one.mjs + scan. TF >=360 (VN H6/daily) tinh theo phien 09:00-15:00;
 * intraday (M5/H1) tinh theo dong ho thuc.
 */
const MKT_OPEN_H = 9;    // VN phien sang mo 09:00
const MKT_CLOSE_H = 15;  // H6/daily dong ~15:00
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const VN_TZ = 'Asia/Ho_Chi_Minh';

function vnParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VN_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const out = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour), minute: Number(out.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(out.weekday),
  };
}

function vnDateKey(value) {
  const p = vnParts(value);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function barStatus(barOpenSec, tfMin, now = new Date()) {
  const nowSec = now.getTime() / 1000;
  if (tfMin >= 360) {
    // VN H6/daily: 1 nen = 1 phien, always evaluated in Asia/Ho_Chi_Minh.
    const current = vnParts(now);
    const sameDay = vnDateKey(new Date(barOpenSec * 1000)) === vnDateKey(now);
    const afterClose = current.hour >= MKT_CLOSE_H;
    const closed = !sameDay || afterClose;
    const minsIn = (current.hour * 60 + current.minute) - MKT_OPEN_H * 60;
    const age_pct = closed ? 100 : clamp(Math.round(minsIn / 360 * 100), 0, 99);
    return { closed, age_pct };
  }
  // intraday M5/H1: theo dong ho thuc tu luc mo nen
  const ageMin = (nowSec - barOpenSec) / 60;
  return { closed: ageMin >= tfMin, age_pct: clamp(Math.round(ageMin / tfMin * 100), 0, 100) };
}

/**
 * sessionInfo — xac dinh phien giao dich VN HOSE (ATO/Continuous/ATC/LUNCH/CLOSED).
 * Chia KHU VUC giao dich de gate trust level cho entry/scan/alert.
 * market != 'VN' → { phase:'N/A', trust_level:'HIGH', warnings:[] } (nhuong thị trường khác).
 * Dong bo logic Python voi tg_alert_watcher.py vn_session_phase().
 */
// Moc chuyen phien (phut trong ngay) + ten phien SAU moc do. Dung chung cho next_phase/minutes_remaining.
const PHASE_BOUNDARIES = [
  [540, 'ATO'], [555, 'EARLY'], [570, 'CONT_AM'], [690, 'LUNCH'],
  [780, 'CONT_PM'], [870, 'ATC'], [885, 'CLOSED'],
];

export function sessionInfo(now = new Date(), market = 'VN') {
  if (market !== 'VN') return { phase: 'N/A', trust_level: 'HIGH', warnings: [], next_phase: null, minutes_remaining: null, phase_warning: null };
  const local = vnParts(now);
  const wd = local.weekday;
  const weekendOrClosed = { next_phase: null, minutes_remaining: null, phase_warning: null };
  if (wd === 0 || wd === 6) return { phase: 'CLOSED', trust_level: 'LOW', warnings: ['weekend'], ...weekendOrClosed };
  const t = local.hour * 60 + local.minute;
  const nextB = PHASE_BOUNDARIES.find(([m]) => m > t);
  const next_phase = nextB ? nextB[1] : null;
  const minutes_remaining = nextB ? nextB[0] - t : null;
  let phase, trust_level, warnings;
  if (t < 540)      { phase = 'CLOSED';   trust_level = 'LOW';  warnings = ['pre_market']; }
  else if (t < 555) { phase = 'ATO';      trust_level = 'LOW';  warnings = ['ato_noisy_delta']; }
  else if (t < 570) { phase = 'EARLY';    trust_level = 'LOW';  warnings = ['early_vol_unstable']; }
  else if (t < 690) { phase = 'CONT_AM';  trust_level = 'HIGH'; warnings = []; }
  else if (t < 780) { phase = 'LUNCH';    trust_level = 'LOW';  warnings = ['lunch_stale_price']; }
  else if (t < 870) { phase = 'CONT_PM';  trust_level = 'HIGH'; warnings = []; }
  else if (t < 885) { phase = 'ATC';      trust_level = 'LOW';  warnings = ['atc_frozen_orderbook']; }
  else              { phase = 'CLOSED';   trust_level = 'HIGH'; warnings = []; } // >14:45 gia dong chinh thuc
  const phase_warning = (phase === 'CONT_PM' && minutes_remaining !== null && minutes_remaining <= 15) ? 'atc_approaching' : null;
  const outNext = phase === 'CLOSED' ? weekendOrClosed : { next_phase, minutes_remaining, phase_warning };
  return { phase, trust_level, warnings, ...outNext };
}

/**
 * entryWindow — classification of entry windows within VN HOSE session.
 * Uses Vietnam timezone (UTC+7), independent of host timezone.
 * Returns one of: HIGH, NORMAL, REDUCED, DISCOVERY, BLOCKED
 * ISO weekdays; [2,3] is Tuesday/Wednesday priority only.
 */
export function entryWindow(now = new Date(), market = 'VN') {
  if (market !== 'VN') return { window: 'N/A', priority: false, reason: 'non_vn' };
  const local = vnParts(now);
  const vnHour = local.hour;
  const vnDayOfWeek = local.weekday;

  const isPriority = vnDayOfWeek === 2 || vnDayOfWeek === 3; // Tue/Wed
  if (vnDayOfWeek === 0 || vnDayOfWeek === 6) {
    return { window: 'BLOCKED', priority: isPriority, reason: 'weekend' };
  }
  const t = vnHour * 60 + local.minute;
  let window, reason;

  if (t < 540 || t >= 885)            { window = 'BLOCKED'; reason = 'market_closed'; }
  else if (t < 555)                   { window = 'BLOCKED'; reason = 'ato'; }
  else if (t < 570)                   { window = 'DISCOVERY'; reason = 'early_discovery'; }
  else if (t < 630)                   { window = 'HIGH'; reason = 'am_high_liquidity'; }
  else if (t < 675)                   { window = 'NORMAL'; reason = 'am_normal'; }
  else if (t < 690)                   { window = 'REDUCED'; reason = 'am_reduced'; }
  else if (t < 780)                   { window = 'BLOCKED'; reason = 'lunch'; }
  else if (t < 795)                   { window = 'DISCOVERY'; reason = 'pm_discovery'; }
  else if (t < 850)                   { window = 'HIGH'; reason = 'pm_high_liquidity'; }
  else if (t < 870)                   { window = 'REDUCED'; reason = 'pm_reduced'; }
  else                                { window = 'BLOCKED'; reason = 'atc'; }

  return { window, priority: isPriority, reason };
}

/**
 * lockedLtf — determine if a lower-timeframe chart has stabilized using
 * per-bar evidence. Each bar carries its own Footprint.
 *
 * M5 requires 2 consecutive qualifying closed bars.
 * M15/H1 requires 1 qualifying closed bar.
 *
 * "Non-bearish" requires ALL of:
 * - bar.symbol matches expectedSymbol
 * - bar.timeframe matches requested timeframe
 * - bar.bar_closed === true, finite closed_at
 * - close >= open
 * - no bearish VSA (footprint.bearish_vsa === true)
 * - no delta divergence (footprint.bearish_divergence === true)
 * - no dominant sell stack
 * - no aggressive selling
 * - no protected-low breach
 * - no trigger-zone breach
 *
 * No global Footprint argument. Each bar.footprint is consumed independently.
 *
 * @param {Object} opts
 * @param {Array}  opts.bars           - Bars with per-bar {symbol, timeframe, bar_closed, closed_at, open, high, low, close, volume, footprint}
 * @param {string} opts.timeframe      - '5', '15', or '60'
 * @param {string} opts.expectedSymbol
 * @param {number} opts.maxAgeMs       - Required max age of most recent closed_at in ms
 * @param {number|Date} [opts.now]
 * @param {number} [opts.protectedLow]
 * @param {number} [opts.triggerZoneLow]
 * @returns {{ locked: boolean, reason: string, checks: Object, required: number, timeframe: string }}
 */
export function lockedLtf({ bars = [], timeframe, expectedSymbol, maxAgeMs, now, protectedLow, triggerZoneLow } = {}) {
  const tfMap = { '5': 5, '15': 15, '60': 60 };

  if (!timeframe) return { locked: false, reason: 'missing_data', checks: {}, required: 0, timeframe };
  if (!expectedSymbol) return { locked: false, reason: 'missing_expected_symbol', checks: {}, required: 0, timeframe };
  if (maxAgeMs == null) return { locked: false, reason: 'missing_max_age', checks: {}, required: 0, timeframe };
  if (!bars.length) return { locked: false, reason: 'missing_data', checks: {}, required: 0, timeframe };

  const tfInt = tfMap[String(timeframe)];
  if (!tfInt) return { locked: false, reason: `unsupported_timeframe:${timeframe}`, checks: {}, required: 0, timeframe };

  const m5 = tfInt === 5;
  const required = m5 ? 2 : 1;
  if (bars.length < required) {
    return { locked: false, reason: `insufficient_bars:need_${required}_got_${bars.length}`, checks: {}, required, timeframe };
  }

  const nowMs = now ? +new Date(now) : Date.now();
  const nowSec = nowMs / 1000;
  const normSym = s => String(s || '').split(':').pop().toUpperCase();
  const expectedNorm = normSym(expectedSymbol);

  const checks = {};
  let allNonBearish = true;

  for (let i = 0; i < required; i++) {
    const bar = bars[bars.length - 1 - i];
    const ft = bar?.footprint || {};
    const failures = [];

    if (!bar) { failures.push('missing'); allNonBearish = false; continue; }

    // Symbol match
    const symOk = normSym(bar.symbol) === expectedNorm;
    if (!symOk) failures.push('wrong_symbol');

    // Timeframe match
    const tfOk = String(bar.timeframe) === String(timeframe);
    if (!tfOk) failures.push('wrong_timeframe');

    // Bar must be closed
    if (bar.bar_closed !== true) failures.push('open');

    // Finite closed_at
    const closedAtMs = bar.closed_at ? +new Date(bar.closed_at) : NaN;
    if (!Number.isFinite(closedAtMs)) failures.push('missing_closed_at');

    // Freshness: now - closed_at within maxAgeMs, not in future beyond 60s skew
    if (Number.isFinite(closedAtMs)) {
      const ageMs = nowMs - closedAtMs;
      if (ageMs < -60000) failures.push('future_closed_at');
      else if (ageMs > maxAgeMs) failures.push('stale');
    }

    // Price action
    const priceUp = bar.close >= bar.open;
    if (!priceUp) failures.push('bearish_price');

    // VSA bearishness
    if (ft.bearish_vsa === true) failures.push('bearish_vsa');

    // Delta divergence
    if (ft.bearish_divergence === true) failures.push('delta_divergence');

    // Dominant sell stack
    const bStack = ft.buy_stack;
    const sStack = ft.sell_stack;
    const spread = bar.high - bar.low;
    const closePos = spread > 0 ? (bar.close - bar.low) / spread : 0.5;
    const dominantSell = sStack != null && bStack != null && sStack > bStack && closePos <= 0.4;
    if (dominantSell) failures.push('dominant_sell_stack');

    // Aggressive selling
    const bPct = ft.buy_pct;
    const aggressiveSell = bPct != null && bPct < 40 && !priceUp;
    if (aggressiveSell) failures.push('aggressive_sell');

    // Protected-low breach
    const lowBreach = protectedLow != null && bar.low <= protectedLow;
    if (lowBreach) failures.push('protected_low_breach');

    // Trigger-zone breach
    const triggerBreach = triggerZoneLow != null && bar.low <= triggerZoneLow;
    if (triggerBreach) failures.push('trigger_zone_breach');

    const barOk = failures.length === 0;
    checks[`bar_${i}`] = {
      ok: barOk,
      symbol: bar.symbol,
      symbol_matched: symOk,
      timeframe: bar.timeframe,
      timeframe_matched: tfOk,
      bar_closed: bar.bar_closed,
      closed_at: bar.closed_at,
      price_up: priceUp,
      bearish_vsa: ft.bearish_vsa,
      bearish_divergence: ft.bearish_divergence,
      dominant_sell_stack: dominantSell,
      aggressive_sell: aggressiveSell,
      low_breach: lowBreach,
      trigger_breach: triggerBreach,
      failures,
    };
    if (!barOk) allNonBearish = false;
  }

  const locked = allNonBearish;
  const failList = Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}=${c.failures.join(',')}`);
  return { locked, reason: locked ? 'locked' : `failed:${failList.join(';')}`, checks, required, timeframe };
}

// ponytail: self-check chay khi goi truc tiep `node bar_status.mjs`
if (process.argv[1] && process.argv[1].endsWith('bar_status.mjs')) {
  const mk = (h, m) => new Date(Date.UTC(2026, 5, 23, h - 7, m)); // VN 23/06/2026
  const vn = (month, day, h, m) => new Date(Date.UTC(2026, month, day, h - 7, m));
  const sec = (d) => d.getTime() / 1000;
  const open9 = sec(mk(9, 0));
  // VN: nen mo 09:00 hom nay, xem luc 09:36 -> chua dong
  console.assert(barStatus(open9, 360, mk(9, 36)).closed === false, 'VN 09:36 phai chua dong');
  // VN: xem luc 15:30 cung ngay -> da dong
  console.assert(barStatus(open9, 360, mk(15, 30)).closed === true, 'VN 15:30 phai dong');
  // VN: nen hom qua, xem hom nay -> da dong
  console.assert(barStatus(sec(mk(9, 0)) - 86400, 360, mk(10, 0)).closed === true, 'VN nen hom qua phai dong');
  // M5: nen mo cach day 3 phut -> chua dong, ~60%
  const nowI = mk(10, 0);
  console.assert(barStatus(sec(nowI) - 180, 5, nowI).closed === false, 'M5 -3p phai chua dong');
  // M5: nen mo cach day 6 phut -> da dong
  console.assert(barStatus(sec(nowI) - 360, 5, nowI).closed === true, 'M5 -6p phai dong');
  // sessionInfo self-check
  const sun = vn(6, 5, 11, 0); // Chu nhat 05/07/2026
  console.assert(sessionInfo(sun).phase === 'CLOSED', 'Sunday phai CLOSED');
  console.assert(sessionInfo(vn(6, 9, 9, 10)).phase === 'ATO', '09:10 phai ATO');
  console.assert(sessionInfo(vn(6, 9, 10, 0)).phase === 'CONT_AM', '10:00 phai CONT_AM');
  console.assert(sessionInfo(vn(6, 9, 14, 40)).phase === 'ATC', '14:40 phai ATC');
  console.assert(sessionInfo(vn(6, 9, 12, 0)).phase === 'LUNCH', '12:00 phai LUNCH');
  console.assert(sessionInfo(vn(6, 9, 9, 20)).phase === 'EARLY', '09:20 phai EARLY');
  console.assert(sessionInfo(vn(6, 9, 13, 30)).phase === 'CONT_PM', '13:30 phai CONT_PM');
  console.assert(sessionInfo(vn(6, 9, 15, 0)).trust_level === 'HIGH', '15:00 trust=HIGH (post-close)');
  console.assert(sessionInfo(new Date(2026, 6, 9, 10, 0), 'FX').phase === 'N/A', 'FX market=N/A');
  // clock countdown self-check (Khoi A1)
  const s1420 = sessionInfo(vn(6, 9, 14, 20));
  console.assert(s1420.next_phase === 'ATC' && s1420.minutes_remaining === 10 && s1420.phase_warning === 'atc_approaching', '14:20 phai con 10ph toi ATC + canh bao');
  const s1000 = sessionInfo(vn(6, 9, 10, 0));
  console.assert(s1000.next_phase === 'LUNCH' && s1000.minutes_remaining === 90 && s1000.phase_warning === null, '10:00 phai con 90ph toi LUNCH, khong canh bao');
  const sClosed = sessionInfo(vn(6, 9, 15, 0));
  console.assert(sClosed.next_phase === null && sClosed.minutes_remaining === null, 'CLOSED phai next_phase=null');
  console.log('sessionInfo self-check OK');
  console.log('bar_status self-check OK');
}
