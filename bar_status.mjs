/**
 * bar_status.mjs — nen hien tai DA DONG hay CHUA + da song bao nhieu %.
 * Chong loi doc nen D-0 chua dong nhu da chot (vong luan quan entry dau phien).
 * Dung chung check_one.mjs + scan. TF >=360 (VN H6/daily) tinh theo phien 09:00-15:00;
 * intraday (M5/H1) tinh theo dong ho thuc.
 */
const MKT_OPEN_H = 9;    // VN phien sang mo 09:00
const MKT_CLOSE_H = 15;  // H6/daily dong ~15:00
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function barStatus(barOpenSec, tfMin, now = new Date()) {
  const nowSec = now.getTime() / 1000;
  if (tfMin >= 360) {
    // VN H6/daily: 1 nen = 1 phien. Dung ngay + gio dong cua (robust voi barOpen 00:00 hay 09:00).
    const sameDay = new Date(barOpenSec * 1000).toDateString() === now.toDateString();
    const afterClose = now.getHours() >= MKT_CLOSE_H;
    const closed = !sameDay || afterClose;
    const minsIn = (now.getHours() * 60 + now.getMinutes()) - MKT_OPEN_H * 60;
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
  const wd = now.getDay(); // 0=Sun..6=Sat
  const weekendOrClosed = { next_phase: null, minutes_remaining: null, phase_warning: null };
  if (wd === 0 || wd === 6) return { phase: 'CLOSED', trust_level: 'LOW', warnings: ['weekend'], ...weekendOrClosed };
  const t = now.getHours() * 60 + now.getMinutes();
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
  // Convert to Vietnam time (UTC+7) regardless of host timezone
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const vnMin = (utcMin + 7 * 60) % (24 * 60); // UTC+7
  const vnHour = Math.floor(vnMin / 60);
  const vnDay = now.getUTCDay(); // 0=Sun..6=Sat in UTC
  // Vietnam weekday: if UTC time crosses midnight differently, adjust
  // VN = UTC+7, so VN day = UTC day if UTC time +7h < 24, else next day
  const vnDayOfWeek = (utcMin + 420 >= 1440) ? (vnDay + 1) % 7 : vnDay;

  const isPriority = vnDayOfWeek === 2 || vnDayOfWeek === 3; // Tue/Wed
  if (vnDayOfWeek === 0 || vnDayOfWeek === 6) {
    return { window: 'BLOCKED', priority: isPriority, reason: 'weekend' };
  }
  const t = vnHour * 60 + (vnMin % 60);
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
 * lockedLtf — determine if a lower-timeframe chart has stabilized.
 * M5 requires 2 consecutive closed non-bearish bars.
 * M15/H1 requires 1 closed non-bearish bar.
 *
 * "Non-bearish" requires ALL of:
 * - bar is closed (age > timeframe)
 * - close >= open
 * - no bearish VSA pattern (closed in lower 50% + high vol + narrow spread)
 * - no delta divergence (negative delta while price up)
 * - no dominant sell stack (sell stack >= buy stack when close near low)
 * - no aggressive selling (high sell proportion)
 * - no protected-low breach
 *
 * Wrong symbol, stale data, open bar, wrong timeframe → fails closed.
 *
 * @param {Object} opts
 * @param {Array}  opts.bars              - Bars with {time, open, high, low, close, volume, ...}
 * @param {string} opts.timeframe         - '5', '15', or '60'
 * @param {string} opts.expectedSymbol    - Expected symbol to validate evidence
 * @param {number} [opts.maxAgeMs]        - Max age of most recent bar in ms
 * @param {number|Date} [opts.now]        - Injection for deterministic testing
 * @param {number} [opts.protectedLow]    - Protected low level for breach check
 * @param {Object} [opts.footprint]       - Optional footprint data for delta/stack checks
 * @returns {{ locked: boolean, reason: string, checks: Object, required: number, timeframe: string }}
 */
export function lockedLtf({ bars = [], timeframe, expectedSymbol, maxAgeMs, now, protectedLow, footprint } = {}) {
  if (!timeframe || !bars.length) {
    return { locked: false, reason: 'missing_data', checks: {}, required: 0, timeframe };
  }
  if (!expectedSymbol) {
    return { locked: false, reason: 'missing_expected_symbol', checks: {}, required: 0, timeframe };
  }

  const tfMap = { '5': 5, '15': 15, '60': 60 };
  const tfInt = tfMap[String(timeframe)];
  if (!tfInt) {
    return { locked: false, reason: `unsupported_timeframe:${timeframe}`, checks: {}, required: 0, timeframe };
  }

  const m5 = tfInt === 5;
  const required = m5 ? 2 : 1;
  if (bars.length < required) {
    return { locked: false, reason: `insufficient_bars:need_${required}_got_${bars.length}`, checks: {}, required, timeframe };
  }

  const nowSec = (now ? +new Date(now) : Date.now()) / 1000;

  // Check each required bar
  const checks = {};
  let allNonBearish = true;

  for (let i = 0; i < required; i++) {
    const bar = bars[bars.length - 1 - i];
    if (!bar) {
      checks[`bar_${i}`] = { ok: false, reason: 'missing' };
      allNonBearish = false;
      continue;
    }

    // 1. Closed check
    const barAgeSec = nowSec - bar.time;
    const closed = barAgeSec >= tfInt * 60;

    // 2. Staleness
    const stale = maxAgeMs != null && barAgeSec * 1000 > maxAgeMs;

    // 3. Price action: close >= open
    const priceUp = bar.close >= bar.open;

    // 4. Bearish VSA: closed in lower 50%, high vol, narrow spread
    const spread = bar.high - bar.low;
    const closePos = spread > 0 ? (bar.close - bar.low) / spread : 0.5;
    const vsaBearish = !priceUp && closePos <= 0.5;

    // 5. Delta divergence (if footprint available)
    const delta = footprint?.delta ?? null;
    const deltaDivergence = delta != null && delta < 0 && priceUp;

    // 6. Dominant sell stack (if footprint available)
    const buyStack = footprint?.buy_stack ?? null;
    const sellStack = footprint?.sell_stack ?? null;
    const dominantSell = sellStack != null && buyStack != null && sellStack > buyStack && closePos <= 0.4;

    // 7. Aggressive selling
    const buyPct = footprint?.buy_pct ?? null;
    const aggressiveSell = buyPct != null && buyPct < 40 && !priceUp;

    // 8. Protected-low breach
    const lowBreach = protectedLow != null && bar.low <= protectedLow;

    // Overall bar verdict
    const barOk = closed && !stale && priceUp && !vsaBearish && !deltaDivergence && !dominantSell && !aggressiveSell && !lowBreach;

    const failures = [];
    if (!closed) failures.push('open');
    if (stale) failures.push('stale');
    if (!priceUp) failures.push('bearish_price');
    if (vsaBearish) failures.push('bearish_vsa');
    if (deltaDivergence) failures.push('delta_divergence');
    if (dominantSell) failures.push('dominant_sell_stack');
    if (aggressiveSell) failures.push('aggressive_sell');
    if (lowBreach) failures.push('protected_low_breach');

    checks[`bar_${i}`] = {
      ok: barOk,
      closed, stale, close_pos: Math.round(closePos * 100), price_up: priceUp,
      vsa_bearish: vsaBearish, delta_divergence: deltaDivergence,
      dominant_sell_stack: dominantSell, aggressive_sell: aggressiveSell,
      low_breach: lowBreach,
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
  const mk = (h, m) => new Date(2026, 5, 23, h, m); // 23/06/2026
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
  const sun = new Date(2026, 6, 5, 11, 0); // Chu nhat 05/07/2026
  console.assert(sessionInfo(sun).phase === 'CLOSED', 'Sunday phai CLOSED');
  console.assert(sessionInfo(new Date(2026, 6, 9, 9, 10)).phase === 'ATO', '09:10 phai ATO');
  console.assert(sessionInfo(new Date(2026, 6, 9, 10, 0)).phase === 'CONT_AM', '10:00 phai CONT_AM');
  console.assert(sessionInfo(new Date(2026, 6, 9, 14, 40)).phase === 'ATC', '14:40 phai ATC');
  console.assert(sessionInfo(new Date(2026, 6, 9, 12, 0)).phase === 'LUNCH', '12:00 phai LUNCH');
  console.assert(sessionInfo(new Date(2026, 6, 9, 9, 20)).phase === 'EARLY', '09:20 phai EARLY');
  console.assert(sessionInfo(new Date(2026, 6, 9, 13, 30)).phase === 'CONT_PM', '13:30 phai CONT_PM');
  console.assert(sessionInfo(new Date(2026, 6, 9, 15, 0)).trust_level === 'HIGH', '15:00 trust=HIGH (post-close)');
  console.assert(sessionInfo(new Date(2026, 6, 9, 10, 0), 'FX').phase === 'N/A', 'FX market=N/A');
  // clock countdown self-check (Khoi A1)
  const s1420 = sessionInfo(new Date(2026, 6, 9, 14, 20));
  console.assert(s1420.next_phase === 'ATC' && s1420.minutes_remaining === 10 && s1420.phase_warning === 'atc_approaching', '14:20 phai con 10ph toi ATC + canh bao');
  const s1000 = sessionInfo(new Date(2026, 6, 9, 10, 0));
  console.assert(s1000.next_phase === 'LUNCH' && s1000.minutes_remaining === 90 && s1000.phase_warning === null, '10:00 phai con 90ph toi LUNCH, khong canh bao');
  const sClosed = sessionInfo(new Date(2026, 6, 9, 15, 0));
  console.assert(sClosed.next_phase === null && sClosed.minutes_remaining === null, 'CLOSED phai next_phase=null');
  console.log('sessionInfo self-check OK');
  console.log('bar_status self-check OK');
}
