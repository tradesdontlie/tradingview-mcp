#!/usr/bin/env python3
"""
Comprehensive Backtest Runner
Runs v7/v8/v9 strategies across all 7 assets and multiple timeframes.
"""

import sys
sys.path.insert(0, '/c/Users/HP/tradingview-mcp/backtest_framework')

import pandas as pd
import numpy as np
from src.strategies.qt_ensemble import QTEnsembleSignalGenerator, StrategyConfig, load_data, load_vix
import json
from datetime import datetime


ASSETS = ['BTCUSD', 'SPX500', 'XAUUSD', 'NQ100', 'NIFTY50', 'BSE', 'BTCUSDT']
TIMEFRAMES = ['1d', '4h', '1h', '1wk', '1mo']

# Strategy configs
STRATEGIES = {
    'v7': StrategyConfig(
        use_ml_filter=False,
        use_kernel=False,
        use_sweep=False,
        use_be=False,
        atr_stop_mult=2.5,
        rr_ratio=2.0,
        long_thresh=0.25,
        short_thresh=-0.25,
        allow_shorts=False,
    ),
    'v8_long': StrategyConfig(
        use_ml_filter=False,
        use_kernel=False,
        use_sweep=True,
        use_be=False,
        atr_stop_mult=2.5,
        rr_ratio=2.0,
        sweep_valid_bars=5,
        piv_len=10,
        gc_period=80,
        gc_poles=4,
        gc_mult=1.414,
        long_thresh=0.0,
        short_thresh=0.0,
        allow_shorts=False,
    ),
    'v8_longshort': StrategyConfig(
        use_ml_filter=False,
        use_kernel=False,
        use_sweep=True,
        use_be=False,
        atr_stop_mult=2.5,
        rr_ratio=2.0,
        sweep_valid_bars=5,
        piv_len=10,
        gc_period=80,
        gc_poles=4,
        gc_mult=1.414,
        long_thresh=0.0,
        short_thresh=0.0,
        allow_shorts=True,
    ),
    'v9': StrategyConfig(
        use_ml_filter=True,
        use_kernel=True,
        use_sweep=True,
        use_be=True,
        atr_stop_mult=1.5,
        rr_ratio=3.0,
        pred_thresh=2,
        signal_fresh_bars=5,
        neighbors_count=8,
        max_bars_back=2000,
        feature_count=5,
        use_vol_filter=True,
        use_regime_filter=True,
        use_trend_filter=True,
    ),
}


def run_backtest(asset: str, timeframe: str, strategy_name: str, config: StrategyConfig) -> dict:
    """Run single backtest and return metrics."""
    try:
        df = load_data(asset, timeframe)
        vix_df = load_vix()
        
        gen = QTEnsembleSignalGenerator(config)
        result = gen.run_full_pipeline(df, vix_df)
        
        # Calculate basic metrics
        long_entries = result['long_entry'].sum()
        short_entries = result['short_entry'].sum() if 'short_entry' in result.columns else 0
        total_entries = long_entries + short_entries
        
        # Simple P&L simulation (vectorized)
        if total_entries > 0:
            # Get entry prices and directions
            entries = result[result['long_entry'] | result['short_entry']].copy()
            
            # Simulate trades with ATR stops/targets
            pnl = 0
            wins = 0
            losses = 0
            
            for idx, row in entries.iterrows():
                if row['long_entry']:
                    direction = 1
                    entry_price = row['close']
                    stop_dist = row['stop_dist'] if 'stop_dist' in row else row['atr'] * config.atr_stop_mult
                    target_dist = row['target_dist'] if 'target_dist' in row else stop_dist * config.rr_ratio
                    stop_price = entry_price - stop_dist
                    target_price = entry_price + target_dist
                else:
                    direction = -1
                    entry_price = row['close']
                    stop_dist = row['stop_dist'] if 'stop_dist' in row else row['atr'] * config.atr_stop_mult
                    target_dist = row['target_dist'] if 'target_dist' in row else stop_dist * config.rr_ratio
                    stop_price = entry_price + stop_dist
                    target_price = entry_price - target_dist
                
                # Look forward for exit
                future_bars = result.loc[idx:].iloc[1:50]  # Max 50 bars
                if len(future_bars) == 0:
                    continue
                
                exit_price = None
                for _, fbar in future_bars.iterrows():
                    if direction == 1:
                        if fbar['low'] <= stop_price:
                            exit_price = stop_price
                            break
                        if fbar['high'] >= target_price:
                            exit_price = target_price
                            break
                    else:
                        if fbar['high'] >= stop_price:
                            exit_price = stop_price
                            break
                        if fbar['low'] <= target_price:
                            exit_price = target_price
                            break
                
                if exit_price is None:
                    # Exit at last bar close
                    exit_price = future_bars.iloc[-1]['close']
                
                trade_pnl = (exit_price - entry_price) * direction
                pnl += trade_pnl
                if trade_pnl > 0:
                    wins += 1
                else:
                    losses += 1
            
            total_trades = wins + losses
            win_rate = wins / total_trades if total_trades > 0 else 0
            avg_win = pnl / total_trades if total_trades > 0 else 0
            
            # Simple Sharpe approximation
            returns = pnl / 100000  # Normalize
            sharpe = returns * np.sqrt(252) if total_trades > 10 else 0
            
            return {
                'asset': asset,
                'timeframe': timeframe,
                'strategy': strategy_name,
                'total_entries': int(total_entries),
                'long_entries': int(long_entries),
                'short_entries': int(short_entries),
                'total_trades': int(total_trades),
                'wins': int(wins),
                'losses': int(losses),
                'win_rate': round(win_rate, 4),
                'total_pnl': round(pnl, 2),
                'avg_trade': round(avg_win, 2),
                'sharpe_approx': round(sharpe, 4),
                'status': 'success'
            }
        else:
            return {
                'asset': asset,
                'timeframe': timeframe,
                'strategy': strategy_name,
                'total_entries': 0,
                'long_entries': 0,
                'short_entries': 0,
                'total_trades': 0,
                'wins': 0,
                'losses': 0,
                'win_rate': 0,
                'total_pnl': 0,
                'avg_trade': 0,
                'sharpe_approx': 0,
                'status': 'no_entries'
            }
    except Exception as e:
        return {
            'asset': asset,
            'timeframe': timeframe,
            'strategy': strategy_name,
            'total_entries': 0,
            'total_trades': 0,
            'sharpe_approx': 0,
            'status': f'error: {str(e)}'
        }


def main():
    vix_df = load_vix()  # Load once
    
    all_results = []
    
    for asset in ASSETS:
        for tf in TIMEFRAMES:
            print(f"\nTesting {asset} {tf}...")
            
            # Check if data exists
            try:
                test_df = load_data(asset, tf)
                print(f"  Data: {len(test_df)} bars")
            except:
                print(f"  No data for {asset} {tf}")
                continue
            
            for strat_name, config in STRATEGIES.items():
                print(f"  Running {strat_name}...")
                result = run_backtest(asset, tf, strat_name, config)
                all_results.append(result)
                print(f"    Entries: {result['total_entries']}, Trades: {result['total_trades']}, Sharpe: {result['sharpe_approx']:.2f}")
    
    # Save results
    results_df = pd.DataFrame(all_results)
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    results_df.to_csv(f'/c/Users/HP/tradingview-mcp/backtest_framework/results/backtest_results_{timestamp}.csv', index=False)
    
    # Print summary
    print("\n" + "="*80)
    print("BACKTEST SUMMARY")
    print("="*80)
    
    # Best by Sharpe
    valid = results_df[results_df['total_trades'] > 10].copy()
    if len(valid) > 0:
        best = valid.nlargest(10, 'sharpe_approx')
        print("\nTop 10 by Sharpe:")
        for _, row in best.iterrows():
            print(f"  {row['asset']} {row['timeframe']} {row['strategy']}: Sharpe={row['sharpe_approx']:.2f}, "
                  f"Trades={row['total_trades']}, WR={row['win_rate']:.1%}, PnL={row['total_pnl']:.0f}")
    
    # Best by PnL
    best_pnl = valid.nlargest(5, 'total_pnl')
    print("\nTop 5 by PnL:")
    for _, row in best_pnl.iterrows():
        print(f"  {row['asset']} {row['timeframe']} {row['strategy']}: PnL={row['total_pnl']:.0f}, "
              f"Trades={row['total_trades']}, WR={row['win_rate']:.1%}")
    
    print(f"\nResults saved to backtest_results_{timestamp}.csv")


if __name__ == '__main__':
    import os
    os.makedirs('/c/Users/HP/tradingview-mcp/backtest_framework/results', exist_ok=True)
    main()