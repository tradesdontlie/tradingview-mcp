/**
 * Headless backtest sidecar (Block B / T118).
 *
 * Pulls a Pine indicator's full-history per-bar output over TradingView's
 * WebSocket (via @mathieuc/tradingview) — no browser — and normalizes it to the
 * same per-bar row shape as the browser-path replay_walk (T115), so downstream
 * analysis is interchangeable between the two engines.
 *
 * Loosely coupled on purpose: the socket lib is dynamically imported inside the
 * fetch function, so it never loads at CDP-server startup and a protocol break
 * can't destabilize the rest of the server. Socket I/O (`fetchStudy`) is
 * injectable via _deps so the transform layer is unit-testable without a socket.
 *
 * Auth: reads TV_SESSION / TV_SIGNATURE from the environment (or opts). The
 * session token is a Critical secret — never hardcode, log, or commit it.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

// TradingView's "not-available" plot sentinel — normalize to null.
export const NA_SENTINEL = 1e100;

function cleanVal(v) {
  return (v === NA_SENTINEL || v === -NA_SENTINEL) ? null : v;
}

function normalizeRow(p) {
  const values = {};
  for (const k in p) {
    if (k === '$time') continue;
    values[k] = cleanVal(p[k]);
  }
  return { t: p.$time, values };
}

// Real socket fetch — dynamically imports the lib, loads the indicator on a
// chart, and resolves the raw study output. Bounded by a hard timeout so a
// hung/broken socket fails loud instead of hanging forever.
async function _defaultFetchStudy({ symbol, timeframe, range, indicatorId, token, signature, timeoutMs = 30000 }) {
  const mod = await import('@mathieuc/tradingview');
  const TradingView = mod.default || mod;
  return await new Promise((resolve, reject) => {
    let client;
    const timer = setTimeout(() => {
      try { client && client.end(); } catch {}
      reject(new Error('Socket timeout — the reverse-engineered protocol may be broken, or the session token is invalid/expired.'));
    }, timeoutMs);
    (async () => {
      client = new TradingView.Client({ token, signature });
      client.onError((...e) => { clearTimeout(timer); reject(new Error('Socket client error: ' + JSON.stringify(e))); });
      // Built-in ("STD;…") load via getIndicator(); user/private ("USER;…") must
      // load via the getPrivateIndicators() descriptor's .get() (getIndicator
      // doesn't resolve USER ids).
      let indicator;
      if (String(indicatorId).startsWith('USER;')) {
        const priv = await TradingView.getPrivateIndicators(token, signature);
        const desc = priv.find(p => p.id === indicatorId);
        if (!desc) throw new Error(`Private indicator not found for this account: ${indicatorId}`);
        indicator = await desc.get();
      } else {
        indicator = await TradingView.getIndicator(indicatorId);
      }
      const chart = new client.Session.Chart();
      chart.setMarket(symbol, { timeframe, range });
      const study = new chart.Study(indicator);
      let settled = false;
      study.onError((...e) => { if (settled) return; settled = true; clearTimeout(timer); try { client.end(); } catch {} reject(new Error('Study error: ' + JSON.stringify(e))); });
      study.onUpdate(() => {
        if (settled || !study.periods || !study.periods.length) return;
        settled = true;
        clearTimeout(timer);
        const out = { chartPeriods: chart.periods || [], studyPeriods: study.periods || [], graphic: study.graphic || {} };
        try { client.end(); } catch {}
        resolve(out);
      });
    })().catch((err) => { clearTimeout(timer); try { client && client.end(); } catch {} reject(err); });
  });
}

function toTsSeconds(dateStr, label) {
  const ms = new Date(dateStr).getTime();
  if (isNaN(ms)) throw new Error(`Invalid ${label} date: "${dateStr}". Use YYYY-MM-DD or ISO.`);
  return Math.floor(ms / 1000);
}

export async function backtestPull({ symbol, timeframe = 'D', from, to, indicatorId, range, out, token, signature, _deps } = {}) {
  const fetchStudy = _deps?.fetchStudy || _defaultFetchStudy;
  const writeFile = _deps?.writeFile || ((p, s) => writeFileSync(p, s));
  const appendFile = _deps?.appendFile || ((p, s) => appendFileSync(p, s));

  if (!symbol) throw new Error('`symbol` is required (e.g. "NASDAQ:AAPL").');
  if (!indicatorId) throw new Error('`indicatorId` is required (e.g. "STD;RSI" or "USER;<hash>").');

  const tok = token || process.env.TV_SESSION;
  const sig = signature || process.env.TV_SIGNATURE;
  if (!tok) throw new Error('No session token — set TV_SESSION (and TV_SIGNATURE) in the environment. Required for indicator data.');

  const fromTs = from != null ? toTsSeconds(from, 'from') : null;
  const toTs = to != null ? toTsSeconds(to, 'to') : null;
  const barRange = Math.max(1, Number(range) || 500);

  const raw = await fetchStudy({ symbol, timeframe, range: barRange, indicatorId, token: tok, signature: sig });

  // Normalize + sort ascending (socket returns newest-first) + date-filter.
  let rows = (raw.studyPeriods || []).map(normalizeRow).filter(r => typeof r.t === 'number');
  rows.sort((a, b) => a.t - b.t);
  if (fromTs != null) rows = rows.filter(r => r.t >= fromTs);
  if (toTs != null) rows = rows.filter(r => r.t <= toTs);

  const g = raw.graphic || {};
  const graphic = {
    labels: (g.labels || []).length,
    lines: (g.lines || g.horizontals || []).length,
    boxes: (g.boxes || []).length,
    tables: (g.tables || []).length,
  };

  // Warn (don't silently mislead) if the pulled window didn't reach `from` —
  // means `range` (bar count) wasn't deep enough to cover the requested start.
  let note;
  if (fromTs != null && rows.length && rows[0].t > fromTs + 86400) {
    note = `Oldest pulled bar (${new Date(rows[0].t * 1000).toISOString().slice(0, 10)}) is after 'from' — increase range to reach further back.`;
  }

  const result = {
    success: true,
    engine: 'socket',
    symbol,
    timeframe,
    indicator_id: indicatorId,
    from: from ?? null,
    to: to ?? null,
    bars_pulled: rows.length,
    graphic,
  };
  if (note) result.note = note;

  if (out != null) {
    if (typeof out !== 'string' || out.includes(' ')) throw new Error('`out` must be a file path string.');
    writeFile(out, '');
    for (const r of rows) appendFile(out, JSON.stringify(r) + '\n');
    result.out_path = out;
  } else {
    result.series = rows;
  }
  return result;
}
