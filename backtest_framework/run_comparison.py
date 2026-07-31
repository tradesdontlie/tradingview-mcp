#!/usr/bin/env python3
"""
Backtest Framework - Multi-Engine Comparison
Runs identical strategy logic across TradingView, Python, and LEAN engines.
"""

import yaml
import pandas as pd
import numpy as np
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Any
from abc import ABC, abstractmethod
import json
from datetime import datetime

from backtest_framework.src.strategies.qt_ensemble import (
    QTEnsembleSignalGenerator, 
    StrategyConfig, 
    load_data, 
    load_vix
)


@dataclass
class BacktestResult:
    """Standardized backtest result container."""
    asset: str
    timeframe: str
    scenario: str
    engine: str
    
    # Performance metrics
    total_return: float
    cagr: float
    sharpe: float
    sortino: float
    max_drawdown: float
    calmar: float
    win_rate: float
    profit_factor: float
    expectancy: float
    avg_trade: float
    avg_holding_bars: float
    exposure: float
    trade_count: int
    
    # Detailed
    trades: List[Dict]
    equity_curve: List[float]
    drawdown_curve: List[float]
    params_used: Dict
    
    # Metadata
    timestamp: str
    data_range: str


class BaseBacktestEngine(ABC):
    """Abstract base class for backtest engines."""
    
    @abstractmethod
    def run(self, df: pd.DataFrame, vix_df: pd.DataFrame, 
            config: StrategyConfig, scenario: Dict) -> BacktestResult:
        pass
    
    def _calculate_metrics(self, equity_curve: np.ndarray, 
                           trades: List[Dict], 
                           initial_capital: float = 100000) -> Dict:
        """Calculate standard performance metrics."""
        if len(equity_curve) == 0:
            return {}
        
        equity = np.array(equity_curve)
        returns = np.diff(equity) / equity[:-1]
        
        # Total return
        total_return = (equity[-1] - initial_capital) / initial_capital
        
        # CAGR
        n_years = len(equity) / 252  # Approximate
        if n_years > 0:
            cagr = (equity[-1] / initial_capital) ** (1 / n_years) - 1
        else:
            cagr = 0
        
        # Sharpe (annualized)
        if len(returns) > 1 and returns.std() > 0:
            sharpe = returns.mean() / returns.std() * np.sqrt(252)
        else:
            sharpe = 0
        
        # Sortino
        downside = returns[returns < 0]
        if len(downside) > 0 and downside.std() > 0:
            sortino = returns.mean() / downside.std() * np.sqrt(252)
        else:
            sortino = sharpe * 2 if sharpe > 0 else 0
        
        # Max Drawdown
        cummax = np.maximum.accumulate(equity)
        drawdown = (equity - cummax) / cummax
        max_dd = drawdown.min()
        
        # Calmar
        calmar = cagr / abs(max_dd) if max_dd != 0 else 0
        
        # Trade metrics
        if trades:
            pnls = [t['pnl'] for t in trades]
            wins = [p for p in pnls if p > 0]
            losses = [p for p in pnls if p < 0]
            win_rate = len(wins) / len(pnls) if pnls else 0
            profit_factor = abs(sum(wins) / sum(losses)) if losses else float('inf')
            expectancy = np.mean(pnls)
            avg_trade = np.mean(pnls)
            avg_holding = np.mean([t.get('bars_held', 0) for t in trades])
        else:
            win_rate = profit_factor = expectancy = avg_trade = avg_holding = 0
        
        # Exposure
        exposure = len([t for t in trades if t.get('size', 0) != 0]) / len(equity) if len(equity) > 0 else 0
        
        return {
            'total_return': total_return,
            'cagr': cagr,
            'sharpe': sharpe,
            'sortino': sortino,
            'max_drawdown': max_dd,
            'calmar': calmar,
            'win_rate': win_rate,
            'profit_factor': profit_factor,
            'expectancy': expectancy,
            'avg_trade': avg_trade,
            'avg_holding_bars': avg_holding,
            'exposure': exposure,
            'trade_count': len(trades)
        }


class PythonBacktestEngine(BaseBacktestEngine):
    """Python vectorized backtest engine using QTEnsembleSignalGenerator."""
    
    def __init__(self, execution_params: Dict):
        self.execution = execution_params
    
    def run(self, df: pd.DataFrame, vix_df: pd.DataFrame, 
            config: StrategyConfig, scenario: Dict) -> BacktestResult:
        """Run vectorized backtest."""
        
        # Merge scenario overrides into execution params
        exec_params = {**self.execution, **scenario}
        
        # Generate signals
        generator = QTEnsembleSignalGenerator(config)
        signals_df = generator.run_full_pipeline(df.copy(), vix_df)
        
        # Run vectorized backtest
        result = self._vectorized_backtest(signals_df, exec_params, config)
        
        return BacktestResult(
            asset=result['asset'],
            timeframe=result['timeframe'],
            scenario=result['scenario'],
            engine='python',
            **result['metrics'],
            trades=result['trades'],
            equity_curve=result['equity_curve'],
            drawdown_curve=result['drawdown_curve'],
            params_used={**asdict(config), **exec_params},
            timestamp=datetime.now().isoformat(),
            data_range=f"{df.index[0].date()} to {df.index[-1].date()}"
        )
    
    def _vectorized_backtest(self, df: pd.DataFrame, exec_params: Dict, 
                             config: StrategyConfig) -> Dict:
        """Run vectorized backtest with proper position management."""
        
        # Extract execution params
        taker_fee = exec_params.get('taker_fee_pct', 0.001)
        slippage = exec_params.get('slippage_bps', 5) / 10000
        liquidity_cap = exec_params.get('liquidity_cap', 0.01)
        
        # Initialize
        equity = 100000.0
        position = 0.0  # + for long, - for short
        entry_price = 0.0
        stop_price = 0.0
        target_price = 0.0
        be_armed = False
        entry_stop = 0.0
        
        equity_curve = [equity]
        trades = []
        position_sizes = []
        
        # Iterate through bars
        for i in range(len(df)):
            row = df.iloc[i]
            close = row['close']
            atr = row.get('atr', close * 0.02)
            
            # Skip if NaN
            if np.isnan(close) or np.isnan(atr):
                equity_curve.append(equity)
                position_sizes.append(position)
                continue
            
            # Check exits first (before new entries)
            if position != 0:
                # Long position
                if position > 0:
                    # Check stop loss
                    stop_dist = atr * config.atr_stop_mult
                    current_stop = entry_stop if not np.isnan(entry_stop) else (entry_price - stop_dist)
                    
                    # Breakeven ratchet
                    if config.use_be and close >= entry_price + stop_dist * config.be_trigger:
                        if not be_armed:
                            be_armed = True
                            current_stop = entry_price
                    
                    # Check stop
                    if close <= current_stop:
                        # Stop hit
                        pnl = (current_stop - entry_price) * position
                        fees = abs(position) * entry_price * exec_params.get('taker_fee_pct', 0.001)
                        slippage_cost = abs(position) * close * exec_params.get('slippage_bps', 5) / 10000
                        net_pnl = pnl - fees - slippage_cost
                        equity += net_pnl
                        
                        trades.append({
                            'entry_time': df.index[i - int(row.get('bars_held', 0))] if i > 0 else df.index[i],
                            'exit_time': df.index[i],
                            'side': 'long',
                            'entry_price': entry_price,
                            'exit_price': current_stop,
                            'size': position,
                            'pnl': net_pnl,
                            'exit_reason': 'stop',
                            'bars_held': i - (i - int(row.get('bars_held', 0))) if 'bars_held' in row else 1
                        })
                        
                        position = 0.0
                        be_armed = False
                        entry_stop = 0.0
                        continue
                    
                    # Check target
                    target_price = entry_price + stop_dist * config.rr_ratio
                    if close >= target_price:
                        pnl = (target_price - entry_price) * position
                        fees = abs(position) * entry_price * exec_params.get('taker_fee_pct', 0.001)
                        slippage_cost = abs(position) * close * exec_params.get('slippage_bps', 5) / 10000
                        net_pnl = pnl - fees - slippage_cost
                        equity += net_pnl
                        
                        trades.append({
                            'exit_time': df.index[i],
                            'side': 'long',
                            'entry_price': entry_price,
                            'exit_price': target_price,
                            'size': position,
                            'pnl': net_pnl,
                            'exit_reason': 'target',
                            'bars_held': i - (i - int(row.get('bars_held', 0))) if 'bars_held' in row else 1
                        })
                        
                        position = 0.0
                        be_armed = False
                        entry_stop = 0.0
                        continue
                    
                    # v9 asymmetric: cut on ML flip against while losing
                    if config.use_ml_filter and 'ml_signal' in row and row.get('ml_signal', 0) == -1:
                        if close < entry_price:  # Losing
                            pnl = (close - entry_price) * position
                            fees = abs(position) * entry_price * exec_params.get('taker_fee_pct', 0.001)
                            slippage_cost = abs(position) * close * exec_params.get('slippage_bps', 5) / 10000
                            net_pnl = pnl - fees - slippage_cost
                            equity += net_pnl
                            
                            trades.append({
                                'exit_time': df.index[i],
                                'side': 'long',
                                'entry_price': entry_price,
                                'exit_price': close,
                                'size': position,
                                'pnl': net_pnl,
                                'exit_reason': 'ml_flip_cut',
                                'bars_held': i - (i - int(row.get('bars_held', 0))) if 'bars_held' in row else 1
                            })
                            
                            position = 0.0
                            be_armed = False
                            entry_stop = 0.0
                            continue
                
                # Short position
                elif position < 0:
                    pos_size = abs(position)
                    stop_dist = atr * config.atr_stop_mult
                    current_stop = entry_stop if not np.isnan(entry_stop) else (entry_price + stop_dist)
                    
                    # Breakeven ratchet
                    if config.use_be and close <= entry_price - stop_dist * config.be_trigger:
                        if not be_armed:
                            be_armed = True
                            current_stop = entry_price
                    
                    # Check stop
                    if close >= current_stop:
                        pnl = (entry_price - current_stop) * pos_size
                        fees = pos_size * entry_price * exec_params.get('taker_fee_pct', 0.001)
                        slippage_cost = pos_size * close * exec_params.get('slippage_bps', 5) / 10000
                        net_pnl = pnl - fees - slippage_cost
                        equity += net_pnl
                        
                        trades.append({
                            'exit_time': df.index[i],
                            'side': 'short',
                            'entry_price': entry_price,
                            'exit_price': current_stop,
                            'size': pos_size,
                            'pnl': net_pnl,
                            'exit_reason': 'stop'
                        })
                        
                        position = 0.0
                        be_armed = False
                        entry_stop = 0.0
                        continue
                    
                    # Check target
                    target_price = entry_price - stop_dist * config.rr_ratio
                    if close <= target_price:
                        pnl = (entry_price - target_price) * pos_size
                        fees = pos_size * entry_price * exec_params.get('taker_fee_pct', 0.001)
                        slippage_cost = pos_size * close * exec_params.get('slippage_bps', 5) / 10000
                        net_pnl = pnl - fees - slippage_cost
                        equity += net_pnl
                        
                        trades.append({
                            'exit_time': df.index[i],
                            'side': 'short',
                            'entry_price': entry_price,
                            'exit_price': target_price,
                            'size': pos_size,
                            'pnl': net_pnl,
                            'exit_reason': 'target'
                        })
                        
                        position = 0.0
                        be_armed = False
                        entry_stop = 0.0
                        continue
                    
                    # v9 asymmetric: cut on ML flip against while losing
                    if config.use_ml_filter and 'ml_signal' in row and row.get('ml_signal', 0) == 1:
                        if close > entry_price:  # Losing short
                            pnl = (entry_price - close) * pos_size
                            fees = pos_size * entry_price * exec_params.get('taker_fee_pct', 0.001)
                            slippage_cost = pos_size * close * exec_params.get('slippage_bps', 5) / 10000
                            net_pnl = pnl - fees - slippage_cost
                            equity += net_pnl
                            
                            trades.append({
                                'exit_time': df.index[i],
                                'side': 'short',
                                'entry_price': entry_price,
                                'exit_price': close,
                                'size': pos_size,
                                'pnl': net_pnl,
                                'exit_reason': 'ml_flip_cut'
                            })
                            
                            position = 0.0
                            be_armed = False
                            entry_stop = 0.0
                            continue
            
            # Check new entries (after exits)
            if position == 0:
                # Long entry
                if row.get('long_entry', False):
                    atr_val = row.get('atr', close * 0.02)
                    stop_dist = atr_val * config.atr_stop_mult
                    risk_cap = equity * (config.risk_per_trade / 100)
                    raw_qty = risk_cap / stop_dist if stop_dist > 0 else 0
                    cap_qty = config.max_lev * equity / close
                    qty = min(raw_qty, cap_qty)
                    
                    if qty > 0:
                        # Apply liquidity cap
                        max_qty = row.get('volume', 1000) * liquidity_cap / close
                        qty = min(qty, max_qty)
                        
                        if qty > 0:
                            # Apply fees and slippage to entry
                            entry_cost = qty * close * (1 + exec_params.get('slippage_bps', 5) / 10000)
                            fees = qty * close * exec_params.get('taker_fee_pct', 0.001)
                            
                            position = qty
                            entry_price = close
                            entry_stop = np.nan  # Will use stop_dist
                            be_armed = False
                            
                            trades.append({
                                'entry_time': df.index[i],
                                'side': 'long',
                                'entry_price': entry_price,
                                'size': qty,
                                'entry_reason': 'signal',
                                'bars_held': 0
                            })
                
                # Short entry
                elif config.allow_shorts and row.get('short_entry', False):
                    atr_val = row.get('atr', close * 0.02)
                    stop_dist = atr_val * config.atr_stop_mult
                    risk_cap = equity * (config.risk_per_trade / 100)
                    raw_qty = risk_cap / stop_dist if stop_dist > 0 else 0
                    cap_qty = config.max_lev * equity / close
                    qty = min(raw_qty, cap_qty)
                    
                    if qty > 0:
                        max_qty = row.get('volume', 1000) * liquidity_cap / close
                        qty = min(qty, max_qty)
                        
                        if qty > 0:
                            position = -qty
                            entry_price = close
                            entry_stop = np.nan
                            be_armed = False
                            
                            trades.append({
                                'entry_time': df.index[i],
                                'side': 'short',
                                'entry_price': entry_price,
                                'size': qty,
                                'entry_reason': 'signal',
                                'bars_held': 0
                            })
            
            # Update bars held for open trades
            for trade in trades:
                if trade.get('exit_time') is None and trade.get('entry_time') is not None:
                    trade['bars_held'] = trade.get('bars_held', 0) + 1
            
            equity_curve.append(equity)
            position_sizes.append(position)
        
        # Close any open position at end
        if position != 0:
            close = df.iloc[-1]['close']
            if position > 0:
                pnl = (close - entry_price) * position
            else:
                pnl = (entry_price - close) * abs(position)
            fees = abs(position) * entry_price * exec_params.get('taker_fee_pct', 0.001)
            slippage_cost = abs(position) * close * exec_params.get('slippage_bps', 5) / 10000
            equity += pnl - fees - slippage_cost
            
            # Update last trade
            if trades:
                trades[-1]['exit_time'] = df.index[-1]
                trades[-1]['exit_price'] = close
                trades[-1]['pnl'] = pnl - fees - slippage_cost
                trades[-1]['exit_reason'] = 'end_of_data'
        
        # Calculate metrics
        equity_arr = np.array(equity_curve)
        metrics = self._calculate_metrics(equity_arr, trades)
        
        # Compute drawdown curve
        cummax = np.maximum.accumulate(equity_arr)
        drawdown = (equity_arr - cummax) / cummax
        
        return {
            'asset': 'BTCUSD',  # Will be overridden
            'timeframe': '4h',
            'scenario': 'baseline',
            'metrics': metrics,
            'trades': trades,
            'equity_curve': equity_arr.tolist(),
            'drawdown_curve': drawdown.tolist()
        }


class TVBacktestEngine(BaseBacktestEngine):
    """TradingView backtest engine via MCP."""
    
    def __init__(self, mcp_client=None):
        self.mcp = mcp_client
    
    def run(self, df: pd.DataFrame, vix_df: pd.DataFrame, 
            config: StrategyConfig, scenario: Dict) -> BacktestResult:
        """Run backtest via TradingView MCP."""
        # This would use the MCP connection to run on TradingView
        # For now, return placeholder
        return BacktestResult(
            asset='placeholder',
            timeframe='4h',
            scenario='baseline',
            engine='tradingview',
            total_return=0, cagr=0, sharpe=0, sortino=0,
            max_drawdown=0, calmar=0, win_rate=0, profit_factor=0,
            expectancy=0, avg_trade=0, avg_holding_bars=0,
            exposure=0, trade_count=0,
            trades=[], equity_curve=[], drawdown_curve=[],
            params_used={}, timestamp=datetime.now().isoformat(),
            data_range=''
        )


class LEANBacktestEngine(BaseBacktestEngine):
    """LEAN QuantConnect backtest engine."""
    
    def __init__(self, lean_path: str = "/c/Users/HP/tradingview-mcp/lean_project/MLRSIStatArb"):
        self.lean_path = lean_path
    
    def run(self, df: pd.DataFrame, vix_df: pd.DataFrame, 
            config: StrategyConfig, scenario: Dict) -> BacktestResult:
        """Run backtest via LEAN CLI."""
        # This would invoke LEAN CLI
        return BacktestResult(
            asset='placeholder',
            timeframe='4h',
            scenario='baseline',
            engine='lean',
            total_return=0, cagr=0, sharpe=0, sortino=0,
            max_drawdown=0, calmar=0, win_rate=0, profit_factor=0,
            expectancy=0, avg_trade=0, avg_holding_bars=0,
            exposure=0, trade_count=0,
            trades=[], equity_curve=[], drawdown_curve=[],
            params_used={}, timestamp=datetime.now().isoformat(),
            data_range=''
        )


def load_config(config_path: str) -> Dict:
    """Load YAML config."""
    with open(config_path) as f:
        return yaml.safe_load(f)


def run_comparison(config_path: str, engines: List[str] = None):
    """Run multi-engine comparison."""
    if engines is None:
        engines = ['python']  # Default to python only
    
    config = load_config(config_path)
    
    # Initialize engines
    engine_instances = {}
    if 'python' in engines:
        engine_instances['python'] = PythonBacktestEngine(config['execution'])
    if 'tradingview' in engines and TVBacktestEngine:
        engine_instances['tradingview'] = TVBacktestEngine()
    if 'lean' in engines and LEANBacktestEngine:
        engine_instances['lean'] = LEANBacktestEngine()
    
    # Load VIX
    vix_df = load_vix()
    
    # Strategy config
    strategy_config = StrategyConfig(**config['strategy_params'])
    
    # Run for each asset, timeframe, scenario
    all_results = []
    
    for asset in config['assets']:
        for tf in config['timeframes']:
            # Load data
            try:
                df = load_data(asset, tf)
                print(f"Loaded {asset} {tf}: {len(df)} bars")
            except Exception as e:
                print(f"Failed to load {asset} {tf}: {e}")
                continue
            
            for scenario_name, scenario_cfg in config['scenarios'].items():
                print(f"Running {asset} {tf} {scenario_name}...")
                
                for engine_name, engine in engine_instances.items():
                    try:
                        result = engine.run(df, load_vix(), strategy_config, scenario_cfg)
                        result.asset = asset
                        result.timeframe = tf
                        result.scenario = scenario_name
                        result.engine = engine_name
                        all_results.append(result)
                        print(f"  {engine_name}: Sharpe={result.sharpe:.3f}, MaxDD={result.max_drawdown:.2%}")
                    except Exception as e:
                        print(f"  {engine_name} ERROR: {e}")
    
    # Save results
    output_dir = Path('/c/Users/HP/tradingview-mcp/backtest_framework/results')
    output_dir.mkdir(parents=True, exist_ok=True)
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    
    # Save detailed results
    results_file = output_dir / f"comparison_{timestamp}.json"
    with open(results_file, 'w') as f:
        json.dump([asdict(r) for r in all_results], f, indent=2, default=str)
    
    # Generate comparison table
    df_results = pd.DataFrame([{
        'asset': r.asset,
        'timeframe': r.timeframe,
        'scenario': r.scenario,
        'engine': r.engine,
        'total_return': r.total_return,
        'sharpe': r.sharpe,
        'sortino': r.sortino,
        'max_drawdown': r.max_drawdown,
        'calmar': r.calmar,
        'win_rate': r.win_rate,
        'profit_factor': r.profit_factor,
        'trade_count': r.trade_count,
        'avg_holding_bars': r.avg_holding_bars
    } for r in all_results])
    
    csv_file = output_dir / f"comparison_table_{timestamp}.csv"
    df_results.to_csv(csv_file, index=False)
    
    print(f"\nResults saved to {results_file}")
    print(f"Comparison table saved to {csv_file}")
    
    return all_results


if __name__ == '__main__':
    import sys
    config_path = sys.argv[1] if len(sys.argv) > 1 else '/c/Users/HP/tradingview-mcp/backtest_framework/config.yaml'
    engines = sys.argv[2:] if len(sys.argv) > 2 else ['python']
    
    results = run_comparison(config_path, engines)
    print("Done!")