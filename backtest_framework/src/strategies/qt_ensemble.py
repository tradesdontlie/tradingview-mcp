#!/usr/bin/env python3
"""
QT Ensemble v7/v8/v9 Signal Generator
Platform-agnostic core logic ported from Pine Script strategies.
"""

import numpy as np
import pandas as pd
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
from enum import Enum
import math


class RegimeType(Enum):
    NORMAL = "normal"
    STRESS = "stress"


@dataclass
class StrategyConfig:
    """All strategy parameters in one place."""
    
    # ============ v7/v8 Ensemble Parameters ============
    mom_len: int = 63
    mom_len_stress: int = 21
    vol_lookback: int = 15
    long_thresh: float = 0.25
    short_thresh: float = -0.25
    allow_shorts: bool = False
    
    # Gaussian Channel (v8/v9)
    gc_period: int = 80
    gc_poles: int = 4
    gc_mult: float = 1.414
    
    # Liquidity (v8/v9)
    piv_len: int = 10
    use_sweep: bool = False
    sweep_valid_bars: int = 5
    
    # ============ v9 ML Parameters ============
    neighbors_count: int = 8
    max_bars_back: int = 2000
    feature_count: int = 5
    use_ml_filter: bool = False
    pred_thresh: int = 4
    signal_fresh_bars: int = 3
    use_kernel: bool = False
    kh: int = 8
    kr: float = 8.0
    kx: int = 25
    
    # ============ Risk Parameters ============
    risk_per_trade: float = 1.0
    atr_len: int = 14
    atr_stop_mult: float = 2.5
    rr_ratio: float = 2.0
    max_lev: float = 1.0
    use_be: bool = False
    be_trigger: float = 1.0
    
    # ============ Regime Parameters ============
    use_vol_filter: bool = True
    use_regime_filter: bool = True
    regime_threshold: float = -0.1
    use_trend_filter: bool = True
    vix_high_thresh: float = 28.0


@dataclass
class SignalState:
    """State variables that persist across bars."""
    ml_signal: int = 0
    bars_since_ml_flip: int = 100000
    bars_since_ssl_sweep: int = 100000
    bars_since_bsl_sweep: int = 100000
    be_armed: bool = False
    entry_stop: float = np.nan


class QTEnsembleSignalGenerator:
    """
    Platform-agnostic signal generator for QT Ensemble strategies.
    Implements v7/v8/v9 logic in pure Python/Pandas.
    """
    
    def __init__(self, config: StrategyConfig):
        self.config = config
        self.state = SignalState()
    
    def compute_indicators(self, df: pd.DataFrame, vix_df: Optional[pd.DataFrame] = None) -> pd.DataFrame:
        """Compute all indicators, return df with new columns."""
        df = df.copy()
        c = self.config
        
        # Ensure required columns
        required = ['open', 'high', 'low', 'close', 'volume']
        for col in required:
            if col not in df.columns:
                raise ValueError(f"Missing required column: {col}")
        
        # ---------- ATR ----------
        df['atr'] = self._atr(df['high'], df['low'], df['close'], c.atr_len)
        
        # ---------- Volume Confirmation ----------
        df['vol_avg'] = df['volume'].rolling(c.vol_lookback).mean()
        df['vol_conf'] = df['volume'] > df['vol_avg']
        
        # ---------- Momentum with Dynamic Lookback ----------
        is_stress = self._is_stress(df, vix_df)
        df['is_stress'] = is_stress
        
        df['m_len'] = np.where(is_stress, c.mom_len_stress, c.mom_len)
        
        # Compute momentum for both regimes
        mom_normal = np.sign(df['close'] / df['close'].shift(c.mom_len) - 1)
        mom_stress = np.sign(df['close'] / df['close'].shift(c.mom_len_stress) - 1)
        df['mom_signal'] = np.where(is_stress, mom_stress, mom_normal)
        df['mom_signal'] = np.where(df['vol_conf'], df['mom_signal'], df['mom_signal'] * 0.5)
        
        # ---------- Mean Reversion (v7/v8) ----------
        df['rsi2'] = self._rsi(df['close'], 2)
        df['mr_signal'] = np.where(
            ~is_stress,
            np.where(df['rsi2'] < 10, 1.0, np.where(df['rsi2'] > 90, -1.0, 0.0)),
            0.0
        )
        
        # ---------- Breakout (v7/v8) ----------
        df['roll_high'] = df['high'].rolling(20).max().shift(1)
        df['roll_low'] = df['low'].rolling(20).min().shift(1)
        df['brk_signal'] = np.where(
            df['close'] > df['roll_high'], 1.0,
            np.where(df['close'] < df['roll_low'], -1.0, 0.0)
        )
        
        # ---------- Combined Ensemble (v7/v8) ----------
        w_mom = np.where(is_stress, 0.85, 0.70)
        df['combined'] = w_mom * df['mom_signal'] + (1 - w_mom) * df['mr_signal'] + 0.10 * df['brk_signal']
        
        # ---------- 52-Week Trend Filter ----------
        df = self._trend_filter(df)
        
        # ---------- Gaussian Channel (v8/v9) ----------
        if c.gc_period > 0:
            df = self._gaussian_channel(df)
        
        # ---------- Liquidity BSL/SSL (v8/v9) ----------
        if c.piv_len > 0:
            df = self._liquidity_levels(df)
        
        # ---------- ML Features (v9) ----------
        if c.use_ml_filter:
            df = self._ml_features(df)
        
        # ---------- Nadaraya-Watson Kernel (v9) ----------
        if c.use_kernel:
            df = self._kernel_estimate(df)
        
        # ---------- VIX Stress ----------
        df['is_stress'] = is_stress
        
        return df
    
    def generate_signals(self, df: pd.DataFrame) -> pd.DataFrame:
        """Generate entry/exit signals from indicators."""
        df = df.copy()
        c = self.config
        
        # ----- v7/v8 Combined Signal -----
        long_sig = (df['combined'] >= c.long_thresh) & (~c.use_trend_filter | df['is_bull'])
        short_sig = c.allow_shorts & (df['combined'] <= c.short_thresh) & (~c.use_trend_filter | ~df['is_bull'])
        
        # ----- v8/v9 Liquidity Sweep Trigger -----
        if 'ssl_sweep' in df.columns:
            long_sig = long_sig & (df['ssl_sweep'] | ~c.use_sweep)
            short_sig = short_sig & (df['bsl_sweep'] | ~c.use_sweep)
        
        # ----- v9 ML Filter -----
        if c.use_ml_filter and 'ml_signal' in df.columns:
            long_sig = long_sig & (df['ml_signal'] == 1) & df['ml_convicted'] & df['ml_fresh']
            short_sig = short_sig & (df['ml_signal'] == -1) & df['ml_convicted'] & df['ml_fresh']
            long_sig = long_sig & df['gc_up'] & df['kern_bull']
            short_sig = short_sig & df['gc_down'] & df['kern_bear']
        
        # ----- Regime Filters -----
        if c.use_vol_filter:
            long_sig = long_sig & df['vol_pass']
            short_sig = short_sig & df['vol_pass']
        if c.use_regime_filter:
            long_sig = long_sig & df['regime_pass']
            short_sig = short_sig & df['regime_pass']
        if c.use_trend_filter:
            long_sig = long_sig & df['is_bull']
            short_sig = short_sig & ~df['is_bull']
        
        df['long_entry'] = long_sig
        df['short_entry'] = short_sig
        
        # ----- Exit Logic (v9 Asymmetric) -----
        df = self._generate_exits(df)
        
        return df
    
    def _generate_exits(self, df: pd.DataFrame) -> pd.DataFrame:
        """Generate exit signals with v9 asymmetric logic."""
        c = self.config
        df = df.copy()
        
        # Stop and target distances
        df['stop_dist'] = df['atr'] * c.atr_stop_mult
        df['target_dist'] = df['stop_dist'] * c.rr_ratio
        
        # v9: Breakeven ratchet
        if c.use_be:
            df['be_price'] = np.nan
        
        return df
    
    # ============ Indicator Implementations ============
    
    def _atr(self, high: pd.Series, low: pd.Series, close: pd.Series, length: int) -> pd.Series:
        """Average True Range."""
        tr1 = high - low
        tr2 = (high - close.shift()).abs()
        tr3 = (low - close.shift()).abs()
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        return tr.rolling(length).mean()
    
    def _rsi(self, src: pd.Series, length: int) -> pd.Series:
        """Relative Strength Index."""
        delta = src.diff()
        gain = delta.where(delta > 0, 0).rolling(length).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(length).mean()
        rs = gain / loss.replace(0, np.nan)
        return 100 - (100 / (1 + rs))
    
    def _is_stress(self, df: pd.DataFrame, vix_df: Optional[pd.DataFrame]) -> pd.Series:
        """Check VIX stress regime."""
        c = self.config
        if vix_df is not None and 'close' in vix_df.columns:
            vix_close = vix_df['close'].reindex(df.index, method='ffill')
            return ~vix_close.isna() & (vix_close > c.vix_high_thresh)
        return pd.Series(False, index=df.index)
    
    def _trend_filter(self, df: pd.DataFrame) -> pd.DataFrame:
        """52-week SMA trend filter."""
        # Weekly SMA(52) ~ Daily SMA(252)
        weekly_sma = df['close'].rolling(252).mean()
        df['avg52w'] = weekly_sma
        df['is_bull'] = weekly_sma.isna() | (df['close'] > weekly_sma)
        return df
    
    def _gaussian_channel(self, df: pd.DataFrame) -> pd.DataFrame:
        """Ehlers N-pole Gaussian Channel (v8/v9)."""
        c = self.config
        
        # Alpha calculation
        beta = (1 - math.cos(2 * math.pi / c.gc_period)) / (math.pow(2**0.5, 2 / c.gc_poles) - 1)
        alpha = -beta + math.sqrt(beta * beta + 2 * beta)
        
        # Cascaded single-pole filters (price)
        src = (df['high'] + df['low'] + df['close']) / 3  # hlc3
        f = pd.Series(np.nan, index=df.index)
        for poles in range(c.gc_poles):
            if poles == 0:
                f = alpha * src + (1 - alpha) * f.fillna(src)
            else:
                f = alpha * f + (1 - alpha) * f.shift().fillna(f)
        
        df['gc_filt'] = f
        
        # TR for bands
        tr = pd.concat([
            df['high'] - df['low'],
            (df['high'] - df['close'].shift()).abs(),
            (df['low'] - df['close'].shift()).abs()
        ], axis=1).max(axis=1)
        
        # Cascaded TR
        f_tr = pd.Series(np.nan, index=df.index)
        for poles in range(c.gc_poles):
            if poles == 0:
                f_tr = alpha * tr + (1 - alpha) * f_tr.fillna(tr)
            else:
                f_tr = alpha * f_tr + (1 - alpha) * f_tr.shift().fillna(f_tr)
        
        df['gc_filtTR'] = f_tr
        df['gc_upper'] = df['gc_filt'] + df['gc_filtTR'] * c.gc_mult
        df['gc_lower'] = df['gc_filt'] - df['gc_filtTR'] * c.gc_mult
        df['gc_up'] = df['gc_filt'] > df['gc_filt'].shift()
        df['gc_down'] = df['gc_filt'] < df['gc_filt'].shift()
        
        return df
    
    def _liquidity_levels(self, df: pd.DataFrame) -> pd.DataFrame:
        """BSL/SSL from swing pivots (v8/v9)."""
        c = self.config
        
        # Pivots using rolling window
        ph = df['high'].rolling(c.piv_len * 2 + 1, center=True).max()
        pl = df['low'].rolling(c.piv_len * 2 + 1, center=True).min()
        
        is_ph = df['high'] == ph
        is_pl = df['low'] == pl
        
        # Forward fill to maintain levels
        bsl = df['high'].where(is_ph).ffill()
        ssl = df['low'].where(is_pl).ffill()
        
        df['bsl'] = bsl
        df['ssl'] = ssl
        
        # Sweep detection
        df['ssl_sweep_raw'] = ~ssl.isna() & (df['low'] < ssl) & (df['close'] > ssl)
        df['bsl_sweep_raw'] = ~bsl.isna() & (df['high'] > bsl) & (df['close'] < bsl)
        
        # Consume level after sweep
        df['ssl'] = ssl.where(~df['ssl_sweep_raw'])
        df['bsl'] = bsl.where(~df['bsl_sweep_raw'])
        
        # Recency latch
        df['bars_since_ssl'] = np.where(df['ssl_sweep_raw'], 0, 
                                         np.arange(len(df)) - np.maximum.accumulate(
                                             np.where(df['ssl_sweep_raw'], np.arange(len(df)), -1)))
        df['bars_since_bsl'] = np.where(df['bsl_sweep_raw'], 0,
                                         np.arange(len(df)) - np.maximum.accumulate(
                                             np.where(df['bsl_sweep_raw'], np.arange(len(df)), -1)))
        
        df['ssl_sweep'] = df['bars_since_ssl'] <= c.sweep_valid_bars
        df['bsl_sweep'] = df['bars_since_bsl'] <= c.sweep_valid_bars
        
        return df
    
    def _ml_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Normalized features for Lorentzian kNN (v9)."""
        c = self.config
        
        # n_rsi: Normalized RSI
        def n_rsi(src, n1, n2):
            rsi_val = self._rsi(src, n1)
            ema_rsi = rsi_val.ewm(span=n2, adjust=False).mean()
            return ema_rsi / 100.0
        
        # n_wt: Normalized WaveTrend
        def n_wt(src, n1, n2):
            ema1 = src.ewm(span=n1, adjust=False).mean()
            ema2 = (src - ema1).abs().ewm(span=n1, adjust=False).mean()
            ci = (src - ema1) / (0.015 * ema2.replace(0, np.nan))
            wt1 = ci.ewm(span=n2, adjust=False).mean()
            wt2 = wt1.rolling(4).mean()
            diff = wt1 - wt2
            lo = diff.rolling(100).min()
            hi = diff.rolling(100).max()
            return np.where(hi - lo != 0, (diff - lo) / (hi - lo), 0.5)
        
        # n_cci: Normalized CCI
        def n_cci(src, n1, n2):
            cci_val = (src - src.rolling(n1).mean()) / (0.015 * src.rolling(n1).std())
            ema_cci = cci_val.ewm(span=n2, adjust=False).mean()
            lo = ema_cci.rolling(100).min()
            hi = ema_cci.rolling(100).max()
            return np.where(hi - lo != 0, (ema_cci - lo) / (hi - lo), 0.5)
        
        # n_adx: Normalized ADX
        def n_adx(high, low, close, n1):
            plus_dm = high.diff()
            minus_dm = -low.diff()
            plus_dm = np.where((plus_dm > minus_dm) & (plus_dm > 0), plus_dm, 0)
            minus_dm = np.where((minus_dm > plus_dm) & (minus_dm > 0), minus_dm, 0)
            tr = pd.concat([
                high - low,
                (high - close.shift()).abs(),
                (low - close.shift()).abs()
            ], axis=1).max(axis=1)
            atr_val = tr.rolling(n1).mean()
            plus_di = 100 * pd.Series(plus_dm, index=high.index).rolling(n1).mean() / atr_val
            minus_di = 100 * pd.Series(minus_dm, index=high.index).rolling(n1).mean() / atr_val
            dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
            adx = dx.rolling(n1).mean()
            return adx / 100.0
        
        df['f1'] = n_rsi(df['close'], 14, 1)
        df['f2'] = n_wt((df['high'] + df['low'] + df['close']) / 3, 10, 11)
        df['f3'] = n_cci(df['close'], 20, 1)
        df['f4'] = n_adx(df['high'], df['low'], df['close'], 20)
        df['f5'] = n_rsi(df['close'], 9, 1)
        
        # Labels: 4-bar forward return direction
        df['y_train'] = np.where(df['close'].shift(-4) < df['close'], -1,
                        np.where(df['close'].shift(-4) > df['close'], 1, 0))
        
        return df
    
    def _kernel_estimate(self, df: pd.DataFrame) -> pd.DataFrame:
        """Nadaraya-Watson Rational Quadratic Kernel (v9)."""
        c = self.config
        
        src = df['close']
        lookback = c.kh
        rel_weight = c.kr
        start_bar = c.kx
        
        sz = min(start_bar + lookback, 300)
        yhat = pd.Series(np.nan, index=df.index)
        
        for i in range(len(df)):
            if i < start_bar:
                yhat.iloc[i] = src.iloc[i]
                continue
            
            max_j = min(i, sz - 1)
            weights = []
            values = []
            
            for j in range(max_j + 1):
                w = (1 + (j**2) / (lookback**2 * 2 * rel_weight)) ** (-rel_weight)
                weights.append(w)
                values.append(src.iloc[i - j])
            
            if sum(weights) != 0:
                yhat.iloc[i] = np.dot(weights, values) / sum(weights)
            else:
                yhat.iloc[i] = src.iloc[i]
        
        df['yhat'] = yhat
        df['kern_bull'] = df['yhat'] > df['yhat'].shift()
        df['kern_bear'] = df['yhat'] < df['yhat'].shift()
        
        return df
    
    def _lorentzian_dist(self, curr: np.ndarray, hist: np.ndarray) -> float:
        """Lorentzian distance between feature vectors."""
        diff = np.abs(curr - hist)
        return np.sum(np.log(1 + diff))
    
    def _lorentzian_knn(self, df: pd.DataFrame) -> pd.DataFrame:
        """Lorentzian kNN classifier (v9) - OPTIMIZED vectorized implementation."""
        c = self.config
        
        features = ['f1', 'f2', 'f3', 'f4', 'f5'][:c.feature_count]
        
        # Build feature matrix and labels
        n = len(df)
        max_lookback = c.max_bars_back
        
        # Prepare feature matrix
        feature_matrix = np.column_stack([df[f].values for f in features])
        label_array = df['y_train'].values
        
        # Pre-allocate outputs
        predictions = np.zeros(len(df))
        ml_signals = np.zeros(len(df), dtype=int)
        ml_convicted = np.zeros(len(df), dtype=bool)
        ml_fresh = np.zeros(len(df), dtype=bool)
        
        # Skip first max_bars_back bars
        max_lookback = c.max_bars_back
        predictions[:max_lookback] = 0
        ml_signals[:max_lookback] = self.state.ml_signal
        ml_convicted[:max_lookback] = False
        ml_fresh[:max_lookback] = False
        
        bars_since_flip = 100000
        current_ml_signal = self.state.ml_signal
        
        # Process in chunks for memory efficiency
        chunk_size = 500
        
        for i in range(c.max_bars_back, len(df), 500):
            end_idx = min(i + 500, len(df))
            
            for j in range(i, end_idx):
                # Current features
                curr_feat = feature_matrix[j]
                
                # Search historical bars
                max_bars_back_idx = max(0, j - c.max_bars_back)
                size_loop = min(c.max_bars_back - 1, j - 1)
                
                # Vectorized distance computation
                hist_indices = np.arange(max_bars_back_idx, max_bars_back_idx + size_loop)
                # Skip every 4th
                mask = hist_indices % 4 != 0
                hist_indices = hist_indices[mask]
                
                if len(hist_indices) == 0:
                    prediction = 0
                else:
                    # Vectorized Lorentzian distance
                    hist_feats = feature_matrix[hist_indices]
                    diff = np.abs(curr_feat - hist_feats)
                    dists = np.sum(np.log(1 + diff), axis=1)
                    
                    # Keep smallest distances (most similar)
                    sorted_indices = np.argsort(dists)
                    keep = sorted_indices[:c.neighbors_count]
                    
                    if len(keep) > 0:
                        pred_values = label_array[hist_indices[keep]]
                        prediction = np.sum(pred_values)
                    else:
                        prediction = 0
                
                predictions[j] = prediction
                
                # ML signal with conviction & freshness
                convicted = abs(prediction) >= c.pred_thresh
                flipped = prediction != 0 and (j < c.max_bars_back or prediction != predictions[j-1])
                bars_since_flip = 0 if flipped else bars_since_flip + 1
                fresh = bars_since_flip <= c.signal_fresh_bars
                
                if prediction > 0 and convicted and fresh:
                    current_ml_signal = 1
                elif prediction < 0 and convicted and fresh:
                    current_ml_signal = -1
                # else keep previous
                
                # Store in arrays
                ml_signals[j] = current_ml_signal
                ml_convicted[j] = convicted
                ml_fresh[j] = fresh
                
                self.state.ml_signal = current_ml_signal
                self.state.bars_since_ml_flip = bars_since_flip
        
        # Apply results to dataframe
        df['ml_prediction'] = predictions
        df['ml_signal'] = ml_signals
        df['ml_convicted'] = ml_convicted
        df['ml_fresh'] = ml_fresh
        
        # Update state
        self.state.ml_signal = current_ml_signal
        
        return df
    
    def _kmlf_regime(self, df: pd.DataFrame) -> pd.DataFrame:
        """Ehlers KLMF regime filter (v9)."""
        c = self.config
        
        src = (df['open'] + df['high'] + df['low'] + df['close']) / 4  # ohlc4
        
        klmf = pd.Series(np.nan, index=df.index)
        value_diff = src - src.shift()
        abs_diff = value_diff.abs()
        
        v1 = value_diff.ewm(span=20, adjust=False).mean()
        v2 = abs_diff.ewm(span=20, adjust=False).mean()
        
        omega = np.where(v2 != 0, np.abs(v1 / v2), 0)
        alpha_k = (-omega**2 + np.sqrt(omega**4 + 16 * omega**2)) / 8
        
        for i in range(len(df)):
            if i == 0:
                klmf.iloc[i] = src.iloc[i]
            else:
                klmf.iloc[i] = alpha_k[i] * src.iloc[i] + (1 - alpha_k[i]) * klmf.iloc[i-1]
        
        abs_slope = (klmf - klmf.shift()).abs()
        exp_slope = abs_slope.ewm(span=200, adjust=False).mean()
        norm_slope_decline = np.where(exp_slope != 0, (abs_slope - exp_slope) / exp_slope, 0)
        
        df['klmf'] = klmf
        df['regime_pass'] = ~c.use_regime_filter | (norm_slope_decline >= c.regime_threshold)
        
        return df
    
    def _volatility_filter(self, df: pd.DataFrame) -> pd.DataFrame:
        """Volatility filter: recent ATR > historical ATR."""
        c = self.config
        recent_atr = df['atr'].rolling(1).mean()
        hist_atr = df['atr'].rolling(10).mean()
        df['vol_pass'] = ~c.use_vol_filter | (recent_atr > hist_atr)
        return df
    
    def _trend_filter(self, df: pd.DataFrame) -> pd.DataFrame:
        """52-week trend filter."""
        weekly_sma = df['close'].rolling(252).mean()
        df['avg52w'] = weekly_sma
        df['is_bull'] = weekly_sma.isna() | (df['close'] > weekly_sma)
        return df
    
    def run_full_pipeline(self, df: pd.DataFrame, vix_df: Optional[pd.DataFrame] = None) -> pd.DataFrame:
        """Run complete signal generation pipeline."""
        c = self.config
        
        # 1. Compute all indicators
        df = self.compute_indicators(df, vix_df)
        
        # 2. ML features & kNN (v9)
        if c.use_ml_filter:
            df = self._ml_features(df)
            df = self._lorentzian_knn(df)
            df = self._kernel_estimate(df)
        
        # 3. Regime filters
        df = self._volatility_filter(df)
        df = self._kmlf_regime(df)
        df = self._trend_filter(df)
        
        # 4. Generate signals
        df = self.generate_signals(df)
        
        return df


def load_data(asset: str, timeframe: str) -> pd.DataFrame:
    """Load data from parquet file."""
    path = f'/c/Users/HP/tradingview-mcp/data/{asset}_{timeframe}.parquet'
    df = pd.read_parquet(path)
    return df


def load_vix() -> pd.DataFrame:
    """Load VIX data."""
    try:
        path = '/c/Users/HP/tradingview-mcp/data/VIX_1d.parquet'
        df = pd.read_parquet(path)
        return df
    except:
        import yfinance as yf
        vix = yf.Ticker('^VIX').history(start='2015-01-01', interval='1d', auto_adjust=True)
        return vix[['Close']].rename(columns={'Close': 'close'})


if __name__ == '__main__':
    # Test with BTCUSD 4h
    df = load_data('BTCUSD', '4h')
    vix_df = load_vix()
    
    # v7 config
    config = StrategyConfig(
        use_ml_filter=False,
        use_kernel=False,
        use_sweep=False,
        use_be=False,
        atr_stop_mult=2.5,
        rr_ratio=2.0,
    )
    
    generator = QTEnsembleSignalGenerator(config)
    result = generator.run_full_pipeline(df, vix_df)
    
    print(f"Data shape: {result.shape}")
    print(f"Long entries: {result['long_entry'].sum()}")
    print(f"Short entries: {result['short_entry'].sum()}")
    print(f"Columns: {list(result.columns)}")