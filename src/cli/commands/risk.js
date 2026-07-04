import { register } from '../router.js';
import * as core from '../../core/risk.js';

register('risk', {
  description: 'Deterministic risk-management math (position sizing, R:R, drawdown, evolving R, trade gate)',
  subcommands: new Map([
    ['size', {
      description: 'Position size from capital, risk %, and stop-loss distance % (optionally capped at available capital)',
      options: {
        'available-capital': { type: 'string', short: 'a', description: 'Actual deployable balance — caps the result at what is executable' },
      },
      handler: (opts, positionals) => {
        const [capital, riskPercent, stopLossPercent] = positionals;
        if (!capital || !riskPercent || !stopLossPercent) {
          throw new Error('Usage: tv risk size <capital> <risk_percent> <stop_loss_percent> [-a available_capital]');
        }
        return core.positionSize({
          capital: Number(capital),
          riskPercent: Number(riskPercent),
          stopLossPercent: Number(stopLossPercent),
          availableCapital: opts['available-capital'] ? Number(opts['available-capital']) : undefined,
        });
      },
    }],
    ['rr', {
      description: 'Risk:reward ratio from entry, stop, target',
      options: {
        side: { type: 'string', short: 's', description: 'long (default) or short' },
      },
      handler: (opts, positionals) => {
        const [entry, stop, target] = positionals;
        if (!entry || !stop || !target) throw new Error('Usage: tv risk rr <entry> <stop> <target> [-s long|short]');
        return core.riskRewardRatio({ entry: Number(entry), stop: Number(stop), target: Number(target), side: opts.side || 'long' });
      },
    }],
    ['breakeven', {
      description: 'Breakeven win rate % needed for a given reward:risk ratio',
      handler: (opts, positionals) => {
        const [rewardPerRisk] = positionals;
        if (!rewardPerRisk) throw new Error('Usage: tv risk breakeven <reward_per_risk>');
        return core.breakevenWinRate({ rewardPerRisk: Number(rewardPerRisk) });
      },
    }],
    ['min-rr', {
      description: 'Minimum reward:risk ratio needed to break even at a given win rate %',
      handler: (opts, positionals) => {
        const [winRate] = positionals;
        if (!winRate) throw new Error('Usage: tv risk min-rr <win_rate_percent>');
        return core.minRewardPerRiskForWinRate({ winRate: Number(winRate) });
      },
    }],
    ['drawdown', {
      description: '% gain required to recover from a given % loss',
      handler: (opts, positionals) => {
        const [lossPercent] = positionals;
        if (!lossPercent) throw new Error('Usage: tv risk drawdown <loss_percent>');
        return core.drawdownRecovery({ lossPercent: Number(lossPercent) });
      },
    }],
    ['evolving-r', {
      description: 'Current R-multiple of an open trade + early-exit threshold flag (< 0.5)',
      options: {
        side: { type: 'string', short: 's', description: 'long (default) or short' },
      },
      handler: (opts, positionals) => {
        const [entry, stop, current] = positionals;
        if (!entry || !stop || !current) throw new Error('Usage: tv risk evolving-r <entry> <stop> <current> [-s long|short]');
        return core.evolvingR({ entry: Number(entry), stop: Number(stop), current: Number(current), side: opts.side || 'long' });
      },
    }],
    ['limits', {
      description: 'Check whether risk % and leverage clear the hard caps (max 3% risk, max 5x leverage)',
      handler: (opts, positionals) => {
        const [riskPercent, leverage] = positionals;
        if (!riskPercent) throw new Error('Usage: tv risk limits <risk_percent> [leverage]');
        return core.checkRiskLimits({ riskPercent: Number(riskPercent), leverage: leverage ? Number(leverage) : 1 });
      },
    }],
    ['gate', {
      description: 'Full Trading Trident pre-trade gate: caps + R:R + position size + win-rate breakeven check',
      options: {
        side: { type: 'string', short: 's', description: 'long (default) or short' },
        leverage: { type: 'string', short: 'l', description: 'Leverage multiplier (default 1)' },
        'win-rate': { type: 'string', short: 'w', description: 'Historical win rate % (enables breakeven check)' },
        'available-capital': { type: 'string', short: 'a', description: 'Actual deployable balance — caps the recommended position size at what is executable' },
      },
      handler: (opts, positionals) => {
        const [capital, riskPercent, entry, stop, target] = positionals;
        if (!capital || !riskPercent || !entry || !stop || !target) {
          throw new Error('Usage: tv risk gate <capital> <risk_percent> <entry> <stop> <target> [-s long|short] [-l leverage] [-w win_rate] [-a available_capital]');
        }
        return core.evaluateTradeSetup({
          capital: Number(capital),
          riskPercent: Number(riskPercent),
          leverage: opts.leverage ? Number(opts.leverage) : 1,
          entry: Number(entry),
          stop: Number(stop),
          target: Number(target),
          side: opts.side || 'long',
          historicalWinRate: opts['win-rate'] ? Number(opts['win-rate']) : undefined,
          availableCapital: opts['available-capital'] ? Number(opts['available-capital']) : undefined,
        });
      },
    }],
    ['translate', {
      description: 'Translate a directional plan ({side, entry}) into an executable order for spot/margin/futures (spot shorts -> sell held inventory)',
      options: {
        'account-type': { type: 'string', short: 't', description: 'spot (default), margin, or futures' },
        'held-quantity': { type: 'string', short: 'q', description: 'Quantity of the asset currently held (default 0) — needed to translate a short onto spot' },
      },
      handler: (opts, positionals) => {
        const [side, entry, positionSizeUsd] = positionals;
        if (!side || !entry || !positionSizeUsd) {
          throw new Error('Usage: tv risk translate <long|short> <entry> <position_size_usd> [-t spot|margin|futures] [-q held_quantity]');
        }
        return core.translateForAccount({
          plan: { side, entry: Number(entry) },
          accountType: opts['account-type'] || 'spot',
          positionSizeUsd: Number(positionSizeUsd),
          heldQuantity: opts['held-quantity'] ? Number(opts['held-quantity']) : 0,
        });
      },
    }],
  ]),
});
