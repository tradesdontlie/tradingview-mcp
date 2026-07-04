import { register } from '../router.js';
import * as core from '../../core/confluence.js';

function parseSignals(json) {
  let signals;
  try { signals = JSON.parse(json); }
  catch { throw new Error('signals must be a JSON array of {strategy, plan: {side}, confirmed_at?} candidate signals'); }
  if (!Array.isArray(signals)) throw new Error('signals must be a JSON array');
  return signals.map(s => ({ strategy: s.strategy, plan: s.plan, confirmedAt: s.confirmed_at }));
}

register('confluence', {
  description: 'Multi-strategy confluence — combine independently-detected signals (e.g. SFP + divergence) into one execution decision; requires 2+ strategies to agree',
  subcommands: new Map([
    ['assess', {
      description: 'Assess whether candidate signals from different strategies agree on direction (returns a combined plan only on agreement)',
      handler: (opts, positionals) => {
        const [signalsJson] = positionals;
        if (!signalsJson) throw new Error('Usage: tv confluence assess \'[{"strategy":"sfp","plan":{"side":"long",...}},{"strategy":"divergence","plan":{"side":"long",...}}]\'');
        return core.assessConfluence({ signals: parseSignals(signalsJson) });
      },
    }],
  ]),
});
