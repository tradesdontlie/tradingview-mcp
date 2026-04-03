import { register } from '../router.js';
import * as core from '../../core/replay.js';
import * as chartCore from '../../core/chart.js';

/**
 * Parse flexible date/time strings into ISO format for TradingView.
 * Accepts: "2025-03-01", "2025-03-01 14:00", "3/1", "3/1 2pm", "mar 1 14:00", "yesterday", "today"
 */
function parseFlexDate(input) {
  if (!input) return undefined;
  const s = input.trim();

  // Already ISO-like
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;

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
  // "14:00", "14:30"
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
  // Bare hour "14"
  if (/^\d{1,2}$/.test(s)) return `${s.padStart(2, '0')}:00`;
  return null;
}

register('replay', {
  description: 'Replay mode controls',
  subcommands: new Map([
    ['start', {
      description: 'Start replay (accepts --timeframe, --interval, --speed for one-shot setup)',
      options: {
        date: { type: 'string', short: 'd', description: 'Start date: 2025-03-01, 3/1, "mar 1 2pm", yesterday, -7d' },
        timeframe: { type: 'string', short: 't', description: 'Set chart timeframe before starting (e.g., 5, 15, 60, D)' },
        interval: { type: 'string', short: 'i', description: 'Replay tick interval: 1T, 1S, 1, 5, auto' },
        speed: { type: 'string', short: 's', description: 'Autoplay delay in ms (100=fast, 1000=normal, 10000=slow)' },
      },
      handler: async (opts, positionals) => {
        const date = parseFlexDate(opts.date || positionals[0]);
        const results = {};

        // Set timeframe first if requested
        if (opts.timeframe) {
          results.timeframe = await chartCore.setTimeframe({ timeframe: opts.timeframe });
          await new Promise(r => setTimeout(r, 500));
        }

        // Start replay
        results.replay = await core.start({ date });

        // Set resolution if requested
        if (opts.interval) {
          results.resolution = await core.setResolution({ interval: opts.interval });
        }

        // Set speed and start autoplay if requested
        if (opts.speed) {
          results.autoplay = await core.autoplay({ speed: Number(opts.speed) });
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
      description: 'Set replay update interval (1T=tick, 1S=second, 1=minute, 5=5min, auto)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Update interval: 1T, 1S, 1, 5, auto' },
      },
      handler: (opts, positionals) => core.setResolution({ interval: opts.interval || positionals[0] }),
    }],
    ['autoplay', {
      description: 'Toggle autoplay in replay mode',
      options: {
        speed: { type: 'string', short: 's', description: 'Autoplay delay in ms (lower = faster)' },
      },
      handler: (opts) => core.autoplay({ speed: opts.speed ? Number(opts.speed) : undefined }),
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
