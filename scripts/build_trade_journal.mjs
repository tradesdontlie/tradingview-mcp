#!/usr/bin/env node
/**
 * Builds trading_journal.xlsx from trade_ledger.jsonl — one row per resolved
 * (or still-open) trade across both the spot and futures live bots.
 *
 * trade_ledger.jsonl is append-only: an 'open' record when a trade is placed,
 * and (futures only) a 'close' record once SL/TP is hit or the position is
 * gone. Records are paired by `id` (the bot's signal/dedup key). Spot trades
 * have no automated close — those rows are left with blank exit/win-loss
 * columns for manual completion.
 *
 * Usage:
 *   node scripts/build_trade_journal.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ExcelJS from 'exceljs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LEDGER_PATH = join(ROOT, 'trade_ledger.jsonl');
const OUT_PATH = join(ROOT, 'trading_journal.xlsx');

function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return [];
  return readFileSync(LEDGER_PATH, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// Pair 'open'/'close' records by (bot, id) into one trade per pair.
function pairTrades(records) {
  const opens = new Map();
  const trades = [];
  for (const rec of records) {
    const key = `${rec.bot}:${rec.id}`;
    if (rec.phase === 'open') {
      opens.set(key, rec);
    } else if (rec.phase === 'close') {
      const open = opens.get(key);
      trades.push({ open, close: rec });
      opens.delete(key);
    }
  }
  // Remaining opens have no close yet — still-open or unresolved (spot).
  for (const open of opens.values()) trades.push({ open, close: null });
  return trades;
}

// Exit price isn't logged directly — derive it from exit_reason + the planned levels.
function exitPrice(open, close) {
  if (!close) return null;
  if (close.exit_reason === 'tp') return open.target ?? close.target ?? null;
  if (close.exit_reason === 'sl') return open.stop ?? close.stop ?? null;
  return null; // 'manual' — exit price unknown without exchange trade history
}

function buildRows(trades) {
  return trades.map(({ open, close }) => {
    const qty = open.qty ?? close?.qty ?? null;
    const entry = open.entry ?? null;
    const target = open.target ?? null;
    const stop = open.stop ?? null;
    const exit = exitPrice(open, close);
    const side = (open.side ?? '').toLowerCase();
    const win = close?.win ?? null;
    const realizedR = close?.realized_r ?? null;

    let pnlPercent = null, pnlSize = null;
    if (exit != null && entry != null) {
      const direction = side === 'short' ? -1 : 1;
      pnlPercent = direction * ((exit - entry) / entry) * 100;
      if (qty != null) pnlSize = direction * (exit - entry) * qty;
    }

    let comments = `combo: ${open.combo ?? 'n/a'}`;
    if (close?.exit_reason) comments += `, exit: ${close.exit_reason}`;
    if (realizedR != null) comments += `, realized R: ${realizedR}`;
    if (!close) comments += open.bot === 'spot' ? ', spot — exit not auto-tracked' : ', still open';

    return {
      market: open.bot === 'futures' ? 'futures' : 'spot',
      symbol: open.symbol,
      direction: side === 'short' ? 'short' : side === 'long' ? 'long' : side,
      qty,
      entry,
      target,
      stop,
      exit,
      plannedRr: open.planned_rr ?? null,
      win,
      pnlPercent,
      pnlSize,
      openedAt: open.ts ?? null,
      closedAt: close?.ts ?? null,
      comments,
    };
  });
}

async function main() {
  const records = loadLedger();
  const trades = pairTrades(records);
  const rows = buildRows(trades);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'tradingview-mcp';
  wb.created = new Date();

  const sheet = wb.addWorksheet('Trade Journal', { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = [
    { header: 'Date Opened',        key: 'openedAt',   width: 22 },
    { header: 'Date Closed',        key: 'closedAt',   width: 22 },
    { header: 'Market',             key: 'market',     width: 10 },
    { header: 'Pair',                key: 'symbol',     width: 12 },
    { header: 'Direction',          key: 'direction',  width: 10 },
    { header: 'Position Size',      key: 'qty',        width: 14 },
    { header: 'Entry Price',        key: 'entry',      width: 14 },
    { header: 'Profit Target',      key: 'target',     width: 14 },
    { header: 'Stop Loss',          key: 'stop',       width: 14 },
    { header: 'Exit Price',         key: 'exit',       width: 14 },
    { header: 'Planned R:R',        key: 'plannedRr',  width: 12 },
    { header: 'Win/Loss',           key: 'win',        width: 10 },
    { header: 'Profit %',           key: 'profitPct',  width: 12 },
    { header: 'Profit Size',        key: 'profitSize', width: 14 },
    { header: 'Loss %',             key: 'lossPct',    width: 12 },
    { header: 'Loss Size',          key: 'lossSize',   width: 14 },
    { header: 'Comments',           key: 'comments',   width: 50 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  headerRow.height = 30;

  for (const r of rows) {
    const isWin = r.win === true;
    const isLoss = r.win === false;
    const row = sheet.addRow({
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      market: r.market,
      symbol: r.symbol,
      direction: r.direction,
      qty: r.qty,
      entry: r.entry,
      target: r.target,
      stop: r.stop,
      exit: r.exit,
      plannedRr: r.plannedRr,
      win: r.win === true ? 'win' : r.win === false ? 'loss' : '',
      profitPct: isWin ? r.pnlPercent : null,
      profitSize: isWin ? r.pnlSize : null,
      lossPct: isLoss ? r.pnlPercent : null,
      lossSize: isLoss ? r.pnlSize : null,
      comments: r.comments,
    });

    ['entry', 'target', 'stop', 'exit', 'profitPct', 'profitSize', 'lossPct', 'lossSize', 'qty', 'plannedRr'].forEach(key => {
      const cell = row.getCell(sheet.getColumn(key).number);
      if (typeof cell.value === 'number') cell.numFmt = '#,##0.00####';
    });

    if (isWin) {
      const cell = row.getCell(sheet.getColumn('win').number);
      cell.font = { color: { argb: 'FF008000' }, bold: true };
    } else if (isLoss) {
      const cell = row.getCell(sheet.getColumn('win').number);
      cell.font = { color: { argb: 'FFCC0000' }, bold: true };
    }
  }

  await wb.xlsx.writeFile(OUT_PATH);
  console.log(`Wrote ${rows.length} trade row(s) to ${OUT_PATH}`);
}

main();
