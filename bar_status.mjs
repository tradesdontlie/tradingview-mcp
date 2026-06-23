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
  console.log('bar_status self-check OK');
}
