import { register } from '../router.js';
import { analyzeChart } from '../../core/agent.js';
import { analyzeRegime } from '../../core/regime.js';

register('agent', {
  description: 'Real-time trading agents — regime classifier + signal alerts',
  subcommands: new Map([
    ['watch', {
      description: 'Signal agent: regime + liquidity sweep / VWAP±2SD / EMA9 alerts',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 1000)' },
      },
      handler: async (opts) => {
        if (opts.interval) process.argv.push('--interval', opts.interval);
        await import(new URL('../../../strategies/trading-agent.js', import.meta.url).href);
      },
    }],
    ['regime', {
      description: 'Regime agent: 4-layer ranging vs trending dashboard for all panes',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 1000)' },
        symbols:  { type: 'string', short: 's', description: 'Comma-separated symbol filter (e.g. MNQ,MGC)' },
      },
      handler: async (opts) => {
        if (opts.interval) process.argv.push('--interval', opts.interval);
        if (opts.symbols)  process.argv.push('--symbols',  opts.symbols);
        await import(new URL('../../../strategies/regime-agent.js', import.meta.url).href);
      },
    }],
    ['once', {
      description: 'Single snapshot — signal analysis (JSON)',
      options: {},
      handler: async () => {
        const result = await analyzeChart();
        console.log(JSON.stringify(result, null, 2));
      },
    }],
    ['regime-once', {
      description: 'Single snapshot — regime analysis for all panes (JSON)',
      options: {},
      handler: async () => {
        const result = await analyzeRegime();
        console.log(JSON.stringify(result, null, 2));
      },
    }],
  ]),
});
