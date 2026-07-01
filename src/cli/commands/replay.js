import { register } from '../router.js';
import * as core from '../../core/replay.js';
import { replayWalk } from '../../core/backtest.js';

register('replay', {
  description: 'Replay mode controls',
  subcommands: new Map([
    ['start', {
      description: 'Start replay mode',
      options: {
        date: { type: 'string', short: 'd', description: 'Start date (YYYY-MM-DD)' },
      },
      handler: (opts) => core.start({ date: opts.date }),
    }],
    ['step', {
      description: 'Advance one bar in replay',
      handler: () => core.step(),
    }],
    ['stop', {
      description: 'Stop replay and return to realtime',
      handler: () => core.stop(),
    }],
    ['set-resolution', {
      description: 'Set replay stepping granularity (e.g. 1H, 1D, auto)',
      options: {
        resolution: { type: 'string', short: 'r', description: 'Replay resolution (1, 1S, 1H, 1D, auto)' },
      },
      handler: (opts, positionals) => core.setResolution({ resolution: opts.resolution ?? positionals[0] }),
    }],
    ['walk', {
      description: 'Backtest capture loop: step from→to, record each bar to JSONL',
      options: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD or ISO)' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD or ISO)' },
        capture: { type: 'string', short: 'c', description: 'Indicator name substring to capture' },
        resolution: { type: 'string', short: 'r', description: 'Replay resolution (e.g. 1H, 1D, auto)' },
        out: { type: 'string', short: 'o', description: 'Write JSONL rows to this file path' },
        'max-bars': { type: 'string', description: 'Safety cap on bars (default 1000)' },
      },
      handler: (opts) => replayWalk({
        from: opts.from,
        to: opts.to,
        capture: opts.capture,
        resolution: opts.resolution,
        out: opts.out,
        max_bars: opts['max-bars'] ? Number(opts['max-bars']) : undefined,
      }),
    }],
    ['status', {
      description: 'Get current replay state',
      handler: () => core.status(),
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
