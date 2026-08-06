#!/usr/bin/env node
/**
 * Post-Session Scan â€” current VN watchlist mÃ£
 * Cháº¡y sau Ä‘Ã³ng phiÃªn (~15:15 VN) má»—i ngÃ y giao dá»‹ch
 * TiÃªu chÃ­: giÃ¡ tÄƒng máº¡nh + volume tÄƒng máº¡nh trong 5 phiÃªn
 * Output: SQLite watchlist + Telegram alert
 */

import https from 'https';
import http  from 'http';
import { spawnSync } from 'child_process';

// â”€â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
const DB_PATH        = 'C:/Users/ADMIN/trading-data/trading.db';

if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) {
  console.error('Missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
}

const TICKERS = [
  'GMD','ACB','VND','OCB','HCM'
];

// NgÆ°á»¡ng lá»c
const THRESHOLDS = {
  A_PLUS: { price5d: 5.0, volRatio: 1.5, upDays: 3 },   // ðŸ”¥ máº¡nh
  GOOD:   { price5d: 3.0, volRatio: 1.3, upDays: 2 },   // âœ… tá»‘t
  WATCH:  { price5d: 2.0, volRatio: 1.5, upDays: 2 },   // âš ï¸ vol tÄƒng máº¡nh
};

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function fetchYF(ticker) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.VN?interval=1d&range=2mo`;
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(d)?.chart?.result?.[0];
          if (!result) return resolve(null);
          const closes  = result.indicators?.quote?.[0]?.close  || [];
          const volumes = result.indicators?.quote?.[0]?.volume || [];
          const times   = result.timestamp || [];
          const bars = [];
          for (let i = 0; i < times.length; i++) {
            if (closes[i] != null && volumes[i] > 0)
              bars.push({ c: closes[i], v: volumes[i] });
          }
          resolve(bars.length >= 8 ? bars : null);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function analyze(ticker, bars) {
  const n   = bars.length;
  const last5  = bars.slice(n - 5);
  const prior  = bars.slice(Math.max(0, n - 25), n - 5);
  if (prior.length < 5) return null;

  const priceNow   = last5[last5.length - 1].c;
  const price5dAgo = last5[0].c;
  const price20dAgo= bars[Math.max(0, n - 21)].c;

  const priceChange5d  = (priceNow - price5dAgo)   / price5dAgo   * 100;
  const priceChange20d = (priceNow - price20dAgo)   / price20dAgo  * 100;

  const avgVol5d   = last5.reduce((s, b) => s + b.v, 0) / last5.length;
  const avgVolPrior= prior.reduce((s, b) => s + b.v, 0) / prior.length;
  const volRatio   = avgVolPrior > 0 ? avgVol5d / avgVolPrior : 1;

  let upDays = 0;
  for (let i = 1; i < last5.length; i++)
    if (last5[i].c >= last5[i - 1].c) upDays++;

  // Consistency: vol Ä‘ang tÄƒng hay Ä‘Ã£ qua rá»“i?
  const volLastDay  = last5[last5.length - 1].v;
  const volAvg5d    = avgVol5d;
  const volTrend    = volLastDay >= volAvg5d * 0.8 ? 'ACTIVE' : 'FADING';

  // Max ngÃ y tÄƒng trong 5 phiÃªn
  let maxDayGain = 0;
  for (let i = 1; i < last5.length; i++) {
    const dg = (last5[i].c - last5[i - 1].c) / last5[i - 1].c * 100;
    if (dg > maxDayGain) maxDayGain = dg;
  }

  const score = priceChange5d * volRatio * (upDays / 4);

  // PhÃ¢n loáº¡i
  let grade = null;
  if (priceChange5d >= THRESHOLDS.A_PLUS.price5d &&
      volRatio      >= THRESHOLDS.A_PLUS.volRatio &&
      upDays        >= THRESHOLDS.A_PLUS.upDays) {
    grade = 'A+';
  } else if (priceChange5d >= THRESHOLDS.GOOD.price5d &&
             volRatio      >= THRESHOLDS.GOOD.volRatio &&
             upDays        >= THRESHOLDS.GOOD.upDays) {
    grade = 'GOOD';
  } else if (priceChange5d >= THRESHOLDS.WATCH.price5d &&
             volRatio      >= THRESHOLDS.WATCH.volRatio &&
             upDays        >= THRESHOLDS.WATCH.upDays) {
    grade = 'WATCH';
  }

  return {
    ticker, priceNow, priceChange5d, priceChange20d,
    volRatio, avgVol5d: Math.round(avgVol5d / 1000),
    upDays, maxDayGain, volTrend, score, grade,
  };
}

function saveToSQLite(results, today) {
  if (results.length === 0) return { saved: 0, skipped: 0 };

  const rows = results.map(r => [
    r.ticker, today,
    `${r.grade} | 5D:${r.priceChange5d.toFixed(1)}% | Vol:${r.volRatio.toFixed(2)}x | ${r.upDays}/5 up | trend:${r.volTrend}`,
    r.priceChange5d, r.priceChange20d, r.volRatio,
    r.avgVol5d, r.priceNow, r.upDays, r.score,
    1, 'post-session-scan'
  ]);

  const pyCode = `
import sys, json, sqlite3, math

rows = json.load(sys.stdin)
conn = sqlite3.connect(r'${DB_PATH}')
c = conn.cursor()
saved = 0; skipped = 0
for row in rows:
    row = [None if isinstance(v, float) and math.isnan(v) else v for v in row]
    try:
        c.execute("""
          INSERT OR IGNORE INTO watchlist
            (ticker, added_date, reason, price_change_5d, price_change_20d,
             vol_ratio, avg_vol_5d, price, up_days, score, active, source)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, row)
        if c.rowcount > 0: saved += 1
        else: skipped += 1
    except Exception as e:
        print(f"ERR {row[0]}: {e}", file=sys.stderr)
conn.commit()
conn.close()
print(json.dumps({'saved': saved, 'skipped': skipped}))
`;

  const res = spawnSync('python', ['-c', pyCode], {
    input: JSON.stringify(rows),
    encoding: 'utf8',
    timeout: 8000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });

  if (res.error || res.status !== 0) {
    console.error('SQLite error:', res.stderr);
    return { saved: 0, skipped: 0 };
  }
  return JSON.parse(res.stdout.trim());
}

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', resolve);
    req.write(body); req.end();
  });
}

function formatDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function todayVN() {
  return new Date(Date.now() + 7 * 3600000);
}

// â”€â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main() {
  const now     = todayVN();
  const today   = formatDate(now);
  const timeStr = now.toTimeString().slice(0, 5);

  // Kiá»ƒm tra ngÃ y thÆ°á»ng (thá»© 2â€“6)
  const dow = now.getUTCDay(); // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) {
    console.log(`[${timeStr}] Weekend â€” skip scan`);
    return;
  }

  console.log(`\nâš¡ POST-SESSION SCAN â€” ${today} ${timeStr} VN`);
  console.log(`Scan ${TICKERS.length} mÃ£ HOSE...`);

  // Fetch all in parallel (batched)
  const allBars = [];
  const BATCH = 12;
  for (let i = 0; i < TICKERS.length; i += BATCH) {
    const batch = TICKERS.slice(i, i + BATCH);
    const res   = await Promise.all(batch.map(t => fetchYF(t)));
    allBars.push(...res.map((bars, j) => ({ ticker: batch[j], bars })));
    if (i + BATCH < TICKERS.length) await new Promise(r => setTimeout(r, 300));
  }

  // Analyze
  const results = [];
  let failed = 0;
  for (const { ticker, bars } of allBars) {
    if (!bars) { failed++; continue; }
    const a = analyze(ticker, bars);
    if (a && a.grade) results.push(a);
  }

  results.sort((a, b) => b.score - a.score);

  const aPlus = results.filter(r => r.grade === 'A+');
  const good  = results.filter(r => r.grade === 'GOOD');
  const watch = results.filter(r => r.grade === 'WATCH');

  console.log(`\nKáº¿t quáº£: ${aPlus.length} A+ | ${good.length} GOOD | ${watch.length} WATCH | ${failed} lá»—i`);

  // In báº£ng
  if (results.length > 0) {
    console.log('\n' + 'â”€'.repeat(72));
    console.log(`${'Grade'.padEnd(6)} ${'MÃ£'.padEnd(5)} ${'GiÃ¡'.padStart(8)} ${'5D%'.padStart(7)} ${'20D%'.padStart(7)} ${'VolRatio'.padStart(9)} ${'AvgVol5d'.padStart(9)} ${'UpD'.padStart(4)} ${'Trend'.padStart(7)}`);
    console.log('â”€'.repeat(72));
    for (const r of results) {
      const grade  = r.grade === 'A+' ? 'ðŸ”¥A+  ' : r.grade === 'GOOD' ? 'âœ…GOOD' : 'âš ï¸WTCH';
      const chg5   = (r.priceChange5d  >= 0 ? '+' : '') + r.priceChange5d.toFixed(1)  + '%';
      const chg20  = (r.priceChange20d >= 0 ? '+' : '') + r.priceChange20d.toFixed(1) + '%';
      console.log(`${grade} ${r.ticker.padEnd(5)} ${String(Math.round(r.priceNow)).padStart(8)} ${chg5.padStart(7)} ${chg20.padStart(7)} ${(r.volRatio.toFixed(2)+'x').padStart(9)} ${(r.avgVol5d+'k').padStart(9)} ${String(r.upDays+'/5').padStart(4)} ${r.volTrend.padStart(7)}`);
    }
    console.log('â”€'.repeat(72));
  }

  // LÆ°u SQLite
  const { saved, skipped } = saveToSQLite(results, today);
  console.log(`\nðŸ’¾ SQLite watchlist: +${saved} má»›i | ${skipped} Ä‘Ã£ cÃ³`);

  // Telegram
  let msg = `ðŸ“Š <b>POST-SESSION SCAN</b> â€” ${today}\n`;
  msg += `ðŸ•’ ${timeStr} VN | Scanned ${TICKERS.length - failed}/${TICKERS.length} mÃ£\n\n`;

  if (aPlus.length > 0) {
    msg += `ðŸ”¥ <b>A+ (priceâ‰¥5% &amp; volâ‰¥1.5x):</b>\n`;
    for (const r of aPlus) {
      msg += `  <b>${r.ticker}</b> ${r.priceNow.toLocaleString('vi')}Ä‘ | +${r.priceChange5d.toFixed(1)}% | ${r.volRatio.toFixed(2)}x vol | ${r.upDays}/5â†‘\n`;
    }
    msg += '\n';
  }

  if (good.length > 0) {
    msg += `âœ… <b>GOOD (priceâ‰¥3% &amp; volâ‰¥1.3x):</b>\n`;
    for (const r of good) {
      msg += `  <b>${r.ticker}</b> ${r.priceNow.toLocaleString('vi')}Ä‘ | +${r.priceChange5d.toFixed(1)}% | ${r.volRatio.toFixed(2)}x vol\n`;
    }
    msg += '\n';
  }

  if (watch.length > 0) {
    msg += `âš ï¸ <b>WATCH (volâ‰¥1.5x tÄƒng Ä‘á»™t biáº¿n):</b>\n`;
    for (const r of watch) {
      msg += `  <b>${r.ticker}</b> | ${r.volRatio.toFixed(2)}x vol | +${r.priceChange5d.toFixed(1)}%\n`;
    }
    msg += '\n';
  }

  if (results.length === 0) {
    msg += `âšª KhÃ´ng cÃ³ mÃ£ nÃ o Ä‘á»§ tiÃªu chÃ­ hÃ´m nay.\n`;
  }

  msg += `ðŸ’¾ ÄÃ£ lÆ°u ${saved} mÃ£ vÃ o <b>watchlist</b> SQLite\n`;
  msg += `ðŸ‘‰ /check [mÃ£] Ä‘á»ƒ phÃ¢n tÃ­ch chi tiáº¿t`;

  await sendTelegram(msg);
  console.log('\nâœ… Telegram Ä‘Ã£ gá»­i');
  console.log('âœ… HoÃ n táº¥t post-session scan\n');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

