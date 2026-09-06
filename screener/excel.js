/**
 * Formats a scan-YYYY-MM-DD.json result into an .xlsx workbook: one summary
 * sheet plus one flat "Sinyal" sheet (one row per matched criterion) that's
 * easy to sort/filter directly in Excel.
 */
import ExcelJS from 'exceljs';
import { shortCriteriaLabel } from './report.js';

export async function generateExcel(scan, outputPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'tradingview-mcp screener';
  wb.created = new Date(scan.generated_at);

  const summary = wb.addWorksheet('Ringkasan');
  summary.columns = [{ width: 40 }, { width: 30 }];
  summary.addRows([
    ['Tanggal Screening', scan.generated_at.slice(0, 10)],
    ['Total Saham Dipindai', scan.total_scanned],
    ['Saham dengan Minimal 1 Sinyal', scan.total_matches],
    ['Error', scan.total_errors],
    ['Disaring (Tidak Likuid)', scan.total_skipped_illiquid ?? 'n/a'],
    ['Threshold AvgValTrx 50 Hari (Rp)', scan.min_avg_value_trx_50d ?? 'n/a'],
    ['Durasi (detik)', scan.elapsed_seconds],
    [],
    ['Disclaimer', 'Hasil analisis teknikal terkomputasi berbasis aturan (rule-based), bukan nasihat investasi dari penasihat keuangan berlisensi. Selalu verifikasi ulang secara manual sebelum mengambil keputusan trading.'],
  ]);
  summary.getRow(1).font = { bold: true };
  summary.getColumn(1).font = { bold: true };
  summary.getCell('B9').alignment = { wrapText: true };

  const sheet = wb.addWorksheet('Sinyal');
  sheet.columns = [
    { header: 'Saham', key: 'symbol', width: 10 },
    { header: 'Close', key: 'close', width: 12 },
    { header: 'Kriteria', key: 'criterion', width: 34 },
    { header: 'Buy Area', key: 'buy_area', width: 18 },
    { header: 'Cutloss', key: 'cutloss', width: 12 },
    { header: 'Take Profit 1', key: 'tp1', width: 14 },
    { header: 'Take Profit 2', key: 'tp2', width: 14 },
    { header: 'Extended Target', key: 'extended', width: 16 },
    { header: 'Nearest Resistance', key: 'resistance', width: 18 },
    { header: 'Nearest Support', key: 'support', width: 16 },
    { header: 'Metode', key: 'method', width: 70 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: 'A1', to: 'K1' };

  for (const stock of scan.results) {
    for (const m of stock.matches) {
      sheet.addRow({
        symbol: stock.symbol,
        close: stock.last_close,
        criterion: shortCriteriaLabel(m.criterion),
        buy_area: m.plan?.buy_area ?? '',
        cutloss: m.plan?.cutloss ?? '',
        tp1: m.plan?.take_profit_1 ?? '',
        tp2: m.plan?.take_profit_2 ?? '',
        extended: m.plan?.extended_target ?? '',
        resistance: stock.nearest_resistance ?? '',
        support: stock.nearest_support ?? '',
        method: m.plan?.method ?? '',
      });
    }
  }

  await wb.xlsx.writeFile(outputPath);
  return outputPath;
}
