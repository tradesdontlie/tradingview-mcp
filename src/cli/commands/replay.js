import { register } from '../router.js';
import * as core from '../../core/replay.js';
import * as chartCore from '../../core/chart.js';
import * as tabCore from '../../core/tab.js';

/**
 * Switch to a tab matching a symbol, title substring, or chart ID.
 * Returns the matched tab or null if no match / only one tab.
 */
async function switchToChart(name) {
  if (!name) return null;
  const { tabs } = await tabCore.list();
  if (tabs.length <= 1) return null;
  const q = name.toLowerCase();
  const match = tabs.find(t =>
    t.title.toLowerCase().includes(q) ||
    (t.chart_id && t.chart_id.toLowerCase() === q)
  );
  if (!match) throw new Error(`No tab matching "${name}". Open tabs: ${tabs.map(t => t.title).join(', ')}`);
  await tabCore.switchTab({ index: match.index });
  await new Promise(r => setTimeout(r, 500));
  return match;
}

/**
 * Parse flexible date/time strings into ISO format for TradingView.
 * Accepts: "2025-03-01", "2025-03-01 14:00", "3/1", "3/1 2pm", "mar 1 14:00", "yesterday", "today"
 */
function parseFlexDate(input) {
  if (!input) return undefined;
  const s = input.trim();

  // Already ISO-like
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;

  // Compact date "20250301" → "2025-03-01"
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

  // "today", "yesterday"
  const now = new Date();
  if (/^today$/i.test(s)) return now.toISOString().slice(0, 10);
  if (/^yesterday$/i.test(s)) {
    now.setDate(now.getDate() - 1);
    return now.toISOString().slice(0, 10);
  }

  // Relative: "-7d", "-2w", "-1m"
  const relMatch = s.match(/^-(\d+)([dwm])$/i);
  if (relMatch) {
    const n = parseInt(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    if (unit === 'd') now.setDate(now.getDate() - n);
    else if (unit === 'w') now.setDate(now.getDate() - n * 7);
    else if (unit === 'm') now.setMonth(now.getMonth() - n);
    return now.toISOString().slice(0, 10);
  }

  // "3/1", "3/1 2pm", "3/1 14:00", "03/01/2025 14:00"
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(.*)?$/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, '0');
    const day = slashMatch[2].padStart(2, '0');
    const year = slashMatch[3] ? (slashMatch[3].length === 2 ? '20' + slashMatch[3] : slashMatch[3]) : String(now.getFullYear());
    const time = parseTime(slashMatch[4]);
    return time ? `${year}-${month}-${day}T${time}` : `${year}-${month}-${day}`;
  }

  // "mar 1", "mar 1 2pm", "march 1 14:00"
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const monMatch = s.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?\s*(.*)?$/i);
  if (monMatch) {
    const mon = months[monMatch[1].toLowerCase().slice(0, 3)];
    if (mon) {
      const day = monMatch[2].padStart(2, '0');
      const year = monMatch[3] || String(now.getFullYear());
      const time = parseTime(monMatch[4]);
      return time ? `${year}-${mon}-${day}T${time}` : `${year}-${mon}-${day}`;
    }
  }

  // Fallback: pass through as-is (let TradingView/Date parse it)
  return s;
}

function parseTime(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim();
  // "14:00", "14:30", "9:30"
  const mil = s.match(/^(\d{1,2}):(\d{2})$/);
  if (mil) return `${mil[1].padStart(2, '0')}:${mil[2]}`;
  // "2pm", "2:30pm", "14"
  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ampm) {
    let h = parseInt(ampm[1]);
    const m = ampm[2] || '00';
    if (ampm[3].toLowerCase() === 'pm' && h < 12) h += 12;
    if (ampm[3].toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  // Bare 4-digit time "0930" → "09:30"
  if (/^\d{4}$/.test(s)) return `${s.slice(0, 2)}:${s.slice(2)}`;
  // Bare hour "14"
  if (/^\d{1,2}$/.test(s)) return `${s.padStart(2, '0')}:00`;
  return null;
}

/**
 * Map human-friendly speed multipliers to TradingView autoplay delays.
 * Lower delay = faster. "1x" is baseline (1000ms).
 */
const SPEED_MAP = {
  '10x': 100, '7x': 143, '5x': 200, '3x': 300,
  '1x': 1000, '0.5x': 2000, '0.3x': 3000, '0.2x': 5000, '0.1x': 10000,
};

function parseSpeed(str) {
  if (!str) return undefined;
  const s = str.trim().toLowerCase();
  if (SPEED_MAP[s] !== undefined) return SPEED_MAP[s];
  const n = Number(s);
  if (!isNaN(n) && n > 0) return n; // raw ms passthrough
  const valid = Object.keys(SPEED_MAP).join(', ');
  throw new Error(`Invalid speed "${str}". Use: ${valid} (or raw ms: 100-10000)`);
}

/**
 * Normalize interval input: case-insensitive, accept friendly aliases.
 */
function parseInterval(str) {
  if (!str) return undefined;
  const s = str.trim().toLowerCase();
  const aliases = { 'chart': 'auto', 'tick': '1T', '1t': '1T', '1s': '1S' };
  if (aliases[s]) return aliases[s];
  return str.trim(); // pass through as-is (runtime validation will catch bad values)
}

register('replay', {
  description: 'Replay mode controls',
  subcommands: new Map([
    ['start', {
      description: 'Start replay: tv replay start -d 20250301 -h 0930 -tf 5 -s 3x -i 1s [-c ES]',
      options: {
        chart: { type: 'string', short: 'c', description: 'Switch to tab matching symbol/name (e.g., ES, AAPL, "My Layout")' },
        date: { type: 'string', short: 'd', description: 'Date: 20250301, 3/1, "mar 1", yesterday, -7d' },
        hour: { type: 'string', short: 'h', description: 'Time: 0930, 9:30, 2pm, 14' },
        tf: { type: 'string', description: 'Chart timeframe (5, 15, 60, D)' },
        speed: { type: 'string', short: 's', description: 'Speed: 1x, 3x, 5x, 7x, 10x (or raw ms)' },
        interval: { type: 'string', short: 'i', description: 'Update interval: 1s, 1t, 1, 5, chart/auto' },
      },
      handler: async (opts, positionals) => {
        // Combine -d and -h, or pick up positionals
        let dateStr = opts.date || positionals[0];
        const hourStr = opts.hour || positionals[opts.date ? 0 : 1];
        if (dateStr && hourStr && parseTime(hourStr)) {
          dateStr = dateStr + ' ' + hourStr;
        }
        const date = parseFlexDate(dateStr);
        const results = {};

        // Switch to matching tab if requested
        if (opts.chart) {
          results.tab = await switchToChart(opts.chart);
        }

        // Set timeframe first if requested
        if (opts.tf) {
          results.timeframe = await chartCore.setTimeframe({ timeframe: opts.tf });
          await new Promise(r => setTimeout(r, 500));
        }

        // Start replay
        results.replay = await core.start({ date });

        // Set speed and start autoplay if requested (before interval — feels right to set pace first)
        if (opts.speed) {
          results.autoplay = await core.autoplay({ speed: parseSpeed(opts.speed) });
        }

        // Set resolution if requested
        if (opts.interval) {
          results.resolution = await core.setResolution({ interval: parseInterval(opts.interval) });
        }

        return { success: true, ...results };
      },
    }],
    ['step', {
      description: 'Advance one bar in replay',
      handler: () => core.step(),
    }],
    ['stop', {
      description: 'Stop replay and return to realtime',
      handler: () => core.stop(),
    }],
    ['status', {
      description: 'Get current replay state',
      handler: () => core.status(),
    }],
    ['resolution', {
      description: 'Set tick interval: tv replay resolution 1s (1t, 1s, 1, 5, chart/auto)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Interval: 1t=tick, 1s=second, 1=min, 5=5min, chart/auto' },
      },
      handler: (opts, positionals) => core.setResolution({ interval: parseInterval(opts.interval || positionals[0]) }),
    }],
    ['autoplay', {
      description: 'Toggle autoplay: tv replay autoplay -s 3x',
      options: {
        speed: { type: 'string', short: 's', description: 'Speed: 1x, 3x, 5x, 7x, 10x (or raw ms)' },
      },
      handler: (opts, positionals) => core.autoplay({ speed: parseSpeed(opts.speed || positionals[0]) }),
    }],
    ['trade', {
      description: 'Execute a trade in replay mode (buy, sell, close)',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Action required. Usage: tv replay trade buy');
        return core.trade({ action: positionals[0] });
      },
    }],
  ]),
});
