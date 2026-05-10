import { register } from '../router.js';
import * as core from '../../core/strategy.js';

register('strategy', {
  description: 'Strategy/workspace helpers',
  subcommands: new Map([
    ['open', {
      description: 'Open a saved strategy/layout by name with optional verification',
      options: {
        symbol: { type: 'string', description: 'Expected active-chart symbol to verify after opening' },
        timeframe: { type: 'string', description: 'Expected active-chart timeframe to verify after opening' },
        panel: { type: 'string', multiple: true, description: 'Panel to open after switching (repeatable)' },
        'dry-run': { type: 'boolean', description: 'Describe what would happen without changing TradingView' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Strategy/layout name required. Usage: tv strategy open "8AM Breakout Algo"');
        return core.openStrategy({
          name: positionals.join(' '),
          symbol: opts.symbol,
          timeframe: opts.timeframe,
          panels: opts.panel,
          dry_run: opts['dry-run'],
        });
      },
    }],
  ]),
});
