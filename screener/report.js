/**
 * Formats a scan-YYYY-MM-DD.json result into a Markdown report grouped by
 * the 7 screening criteria, in Indonesian, with trading-plan levels and a
 * standing disclaimer (this is rule-based TA output, not licensed
 * financial advice).
 */
// Single source of truth for criterion display names — excel.js reuses this
// (via shortCriteriaLabel) instead of keeping its own separate label map, so
// the two report formats can't drift out of sync with each other.
export const CRITERIA_ORDER = [
  { key: 'downtrend_break', title: '2. Breakout Downtrend Line (Uptrend Terkonfirmasi)' },
  { key: 'elliott_wave2', title: '3a. Elliott Wave 2 Dipertahankan (Entry Paling Awal, Fibonacci)' },
  { key: 'elliott_wave', title: '3b. Elliott Wave 5 Selesai/Berjalan (Uptrend Terkonfirmasi, Fibonacci)' },
  { key: 'pullback_reversal', title: '3c. Reversal dari Pullback Wave 2 (Zona Fibonacci)' },
  { key: 'double_bottom', title: '4a. Pattern: Double Bottom' },
  { key: 'inverse_head_and_shoulders', title: '4b. Pattern: Inverted Head & Shoulders' },
  { key: 'cup_and_handle', title: '4c. Pattern: Cup and Handle' },
  { key: 'bullish_flag', title: '4d. Pattern: Bullish Flag' },
  { key: 'bullish_pennant', title: '4e. Pattern: Bullish Pennant' },
  { key: 'breakout_resistance_with_volume', title: '5. Breakout Resistance + Volume' },
  { key: 'volume_spike_green_candle', title: '6. Volume Spike + Candle Hijau' },
  { key: 'confirmed_uptrend', title: '7. Confirmed Uptrend (Follow the Trend)' },
];

/** Criterion title without the report's numbering prefix ("3a. ", "4b. ") — for contexts like Excel columns that don't use that numbering. */
export function shortCriteriaLabel(key) {
  const entry = CRITERIA_ORDER.find(c => c.key === key);
  if (!entry) return key;
  return entry.title.replace(/^\d+[a-z]?\.\s*/, '');
}

function formatPlan(plan) {
  if (!plan) return '';
  const lines = [
    `  - Buy Area: ${plan.buy_area}`,
    `  - Cutloss: ${plan.cutloss}`,
    `  - Take Profit 1: ${plan.take_profit_1}`,
    `  - Take Profit 2: ${plan.take_profit_2}`,
  ];
  if (plan.extended_target) lines.push(`  - Extended Target: ${plan.extended_target}`);
  lines.push(`  - Metode: ${plan.method}`);
  return lines.join('\n');
}

export function generateReport(scan) {
  const dateStr = scan.generated_at.slice(0, 10);
  const buckets = new Map(CRITERIA_ORDER.map(c => [c.key, []]));

  for (const stock of scan.results) {
    for (const m of stock.matches) {
      if (!buckets.has(m.criterion)) continue;
      buckets.get(m.criterion).push({ symbol: stock.symbol, last_close: stock.last_close, ...m });
    }
  }

  const lines = [];
  lines.push(`# Screening Teknikal IHSG — ${dateStr}`);
  lines.push('');
  lines.push('> **Disclaimer:** Ini adalah hasil analisis teknikal terkomputasi berbasis aturan (rule-based),');
  lines.push('> bukan nasihat investasi dari penasihat keuangan berlisensi. Elliott Wave dan pola chart di sini');
  lines.push('> dideteksi lewat heuristik pivot/Fibonacci, bukan penilaian visual pasti — selalu verifikasi ulang');
  lines.push('> secara manual sebelum mengambil keputusan trading. Kriteria "Support & Resistance" digunakan');
  lines.push('> sebagai konteks pendukung di setiap kandidat (kolom S/R terdekat), bukan filter tersendiri.');
  lines.push('');
  lines.push(`Total saham dipindai: **${scan.total_scanned}** | Saham dengan minimal 1 sinyal: **${scan.total_matches}** | Error: ${scan.total_errors} | Durasi: ${scan.elapsed_seconds}s`);
  if (scan.total_skipped_illiquid != null) {
    const minRp = (scan.min_avg_value_trx_50d / 1e9).toFixed(1);
    lines.push(`Disaring karena tidak likuid (AvgValTrx 50 hari < Rp ${minRp} miliar): **${scan.total_skipped_illiquid}** saham`);
  }
  lines.push('');

  for (const { key, title } of CRITERIA_ORDER) {
    const hits = buckets.get(key);
    if (hits.length === 0) continue;
    lines.push(`## ${title} — ${hits.length} saham`);
    lines.push('');
    for (const hit of hits) {
      lines.push(`### ${hit.symbol} (close: ${hit.last_close})`);
      lines.push(formatPlan(hit.plan));
      lines.push('');
    }
  }

  const anyMatches = CRITERIA_ORDER.some(c => buckets.get(c.key).length > 0);
  if (!anyMatches) {
    lines.push('Tidak ada saham yang memenuhi kriteria screening hari ini.');
  }

  return lines.join('\n');
}

const CRITERIA_LABEL_BY_KEY = new Map(CRITERIA_ORDER.map(c => [c.key, c.title]));

export function generatePerformanceReport(perf) {
  const checkDateStr = perf.generated_at.slice(0, 10);
  const scanDateStr = perf.scan_date ?? checkDateStr;
  const won = perf.rows.filter(r => r.status.includes('TP')).length;
  const lost = perf.rows.filter(r => r.status === 'Kena Cutloss').length;
  const running = perf.rows.filter(r => r.status === 'Berjalan').length;

  const lines = [];
  lines.push(`# Performa Screening IHSG Tanggal ${scanDateStr} (Dicek ${checkDateStr})`);
  lines.push('');
  lines.push(`> Perbandingan harga saat screening tanggal ${scanDateStr} dibuat vs harga saat ini (${checkDateStr}).`);
  lines.push('> Bukan simulasi hasil trading riil — belum memperhitungkan biaya transaksi, slippage, atau eksekusi order aktual.');
  lines.push('');
  lines.push(`Total sinyal dicek: **${perf.rows.length}** | TP tercapai: **${won}** | Kena cutloss: **${lost}** | Masih berjalan: **${running}** | Error: ${perf.errors.length}`);
  lines.push('');

  const sorted = [...perf.rows].sort((a, b) => b.change_pct - a.change_pct);
  for (const r of sorted) {
    const label = CRITERIA_LABEL_BY_KEY.get(r.criterion) ?? r.criterion;
    const sign = r.change_pct >= 0 ? '+' : '';
    lines.push(`- **${r.symbol}** (${label}): ${r.signal_price} → ${r.close} (${sign}${r.change_pct}%) — ${r.status}`);
  }

  if (perf.rows.length === 0) {
    lines.push('Tidak ada sinyal pagi untuk dicek hari ini.');
  }

  return lines.join('\n');
}
