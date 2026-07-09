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
export function sessionInfo(now = new Date(), market = 'VN') {
  if (market !== 'VN') return { phase: 'N/A', trust_level: 'HIGH', warnings: [] };
  const wd = now.getDay(); // 0=Sun..6=Sat
  if (wd === 0 || wd === 6) return { phase: 'CLOSED', trust_level: 'LOW', warnings: ['weekend'] };
  const t = now.getHours() * 60 + now.getMinutes();
  if (t < 540)  return { phase: 'CLOSED',    trust_level: 'LOW',  warnings: ['pre_market'] };
  if (t < 555)  return { phase: 'ATO',       trust_level: 'LOW',  warnings: ['ato_noisy_delta'] };
  if (t < 570)  return { phase: 'EARLY',     trust_level: 'LOW',  warnings: ['early_vol_unstable'] };
  if (t < 690)  return { phase: 'CONT_AM',   trust_level: 'HIGH', warnings: [] };
  if (t < 780)  return { phase: 'LUNCH',     trust_level: 'LOW',  warnings: ['lunch_stale_price'] };
  if (t < 870)  return { phase: 'CONT_PM',   trust_level: 'HIGH', warnings: [] };
  if (t < 885)  return { phase: 'ATC',       trust_level: 'LOW',  warnings: ['atc_frozen_orderbook'] };
  return { phase: 'CLOSED', trust_level: 'HIGH', warnings: [] }; // >14:45 gia dong chinh thuc
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
  console.log('sessionInfo self-check OK');
  console.log('bar_status self-check OK');
}
