/**
 * Extracts session high/low/POC from OHLCV bars using UTC-based session windows.
 * Times are in UTC. ET = UTC−5 (EST). Adjust for DST manually if needed.
 *
 * @module sessionEngine
 */

/**
 * @typedef {{ startUtcHour: number, endUtcHour: number, crossesMidnight: boolean }} SessionWindow
 *
 * @typedef {{ startUtcHour: number, endUtcHour: number, crossesMidnight: boolean,
 *             asia: SessionWindow, london: SessionWindow, nyOpen: SessionWindow }} SessionConfig
 *
 * @typedef {{ high: number|null, low: number|null, poc: number|null, found: boolean }} SessionLevelStats
 *
 * @typedef {{ asia: SessionLevelStats, london: SessionLevelStats,
 *             nyOpenRange: { high: number|null, low: number|null, found: boolean },
 *             priorDay:    { high: number|null, low: number|null, found: boolean } }} SessionLevels
 */

/**
 * Default session windows in UTC hours.
 * Asia:    19:00–00:00 ET  →  00:00–05:00 UTC next day  (crossesMidnight)
 * London:  02:00–08:00 ET  →  07:00–13:00 UTC
 * NY open: 09:30–10:00 ET  →  14:00–15:00 UTC (approximate; first 30 min of RTH)
 *
 * @returns {SessionConfig}
 */
export function getDefaultSessionConfig() {
  return {
    asia:   { startUtcHour: 23, endUtcHour: 5,  crossesMidnight: true  },
    london: { startUtcHour: 7,  endUtcHour: 13, crossesMidnight: false },
    nyOpen: { startUtcHour: 14, endUtcHour: 15, crossesMidnight: false },
  };
}

/** @param {number} tsMs @returns {number} UTC hour 0–23 */
function utcHour(tsMs) {
  return new Date(tsMs).getUTCHours();
}

/** @param {number} tsMs @returns {string} "YYYY-MM-DD" in UTC */
function utcDateStr(tsMs) {
  const d = new Date(tsMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

/** @param {number} h @param {SessionWindow} cfg @returns {boolean} */
function inWindow(h, cfg) {
  if (cfg.crossesMidnight) return h >= cfg.startUtcHour || h < cfg.endUtcHour;
  return h >= cfg.startUtcHour && h < cfg.endUtcHour;
}

/**
 * Computes high, low, and POC (bar with highest volume) for a set of bars.
 *
 * @param {Array<{high:number,low:number,close:number,vol:number}>} sessionBars
 * @returns {SessionLevelStats}
 */
function sessionStats(sessionBars) {
  if (!sessionBars.length) return { high: null, low: null, poc: null, found: false };
  let high = -Infinity, low = Infinity, pocBar = sessionBars[0];
  for (const b of sessionBars) {
    if (b.high > high) high = b.high;
    if (b.low  < low)  low  = b.low;
    if (b.vol  > pocBar.vol) pocBar = b;
  }
  return { high, low, poc: pocBar.close, found: true };
}

/**
 * Extracts session levels from a bar array.
 *
 * @param {Array<{ts:number,open:number,high:number,low:number,close:number,vol:number}>} bars
 * @param {SessionConfig} [config]
 * @returns {SessionLevels}
 */
export function extractSessionLevels(bars, config = getDefaultSessionConfig()) {
  const empty = { high: null, low: null, poc: null, found: false };
  if (!bars.length) {
    return { asia: { ...empty }, london: { ...empty }, nyOpenRange: { high: null, low: null, found: false }, priorDay: { high: null, low: null, found: false } };
  }

  const lastDate = utcDateStr(bars[bars.length - 1].ts);

  const asiaBars   = bars.filter(b => inWindow(utcHour(b.ts), config.asia));
  const londonBars = bars.filter(b => inWindow(utcHour(b.ts), config.london));
  const nyBars     = bars.filter(b => inWindow(utcHour(b.ts), config.nyOpen));
  const priorBars  = bars.filter(b => utcDateStr(b.ts) < lastDate);

  const asiaStats   = sessionStats(asiaBars);
  const londonStats = sessionStats(londonBars);
  const nyStats     = sessionStats(nyBars);

  let pdHigh = null, pdLow = null, pdFound = false;
  if (priorBars.length) {
    pdHigh  = Math.max(...priorBars.map(b => b.high));
    pdLow   = Math.min(...priorBars.map(b => b.low));
    pdFound = true;
  }

  return {
    asia:        asiaStats,
    london:      londonStats,
    nyOpenRange: { high: nyStats.high, low: nyStats.low, found: nyStats.found },
    priorDay:    { high: pdHigh, low: pdLow, found: pdFound },
  };
}
