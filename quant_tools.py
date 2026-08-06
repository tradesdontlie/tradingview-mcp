"""
Quant Tools — GARCH + Monte Carlo + VaR
Tích hợp vào /check, /algotrader risk, /algotrader stats

Usage:
    python quant_tools.py garch VCB           → GARCH volatility forecast cho 1 mã
    python quant_tools.py mc                  → Monte Carlo từ journal.db
    python quant_tools.py mc --wr 42 --rr 1.8 --n 50   → Monte Carlo với params thủ công
    python quant_tools.py var VCB MWG STB     → VaR danh mục (lấy positions từ args)
    python quant_tools.py all VCB             → Chạy cả 3, output JSON

Output JSON → stdout | Progress → stderr
"""

import sys, json, math, sqlite3, urllib.request, time, random
from datetime import datetime, date
from collections import defaultdict
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')

DB_PATH  = Path(__file__).parent / "journal.db"
CAPITAL  = 60_000_000   # VND

random.seed(42)

# ═══════════════════════════════════════════════════════════════════════════════
# UTILITIES
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_returns(ticker, years=3):
    url = (f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}.VN'
           f'?interval=1d&range={years}y')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            d = json.loads(r.read())
        cs = d['chart']['result'][0]['indicators']['quote'][0]['close']
        cs = [c for c in cs if c and c > 0]
        return [(cs[i]/cs[i-1] - 1)*100 for i in range(1, len(cs))]
    except:
        return []

def mean(xs):
    return sum(xs)/len(xs) if xs else 0.0

def var_sample(xs):
    if len(xs) < 2: return 0.0
    m = mean(xs)
    return sum((x-m)**2 for x in xs)/(len(xs)-1)

def percentile(xs, p):
    s = sorted(xs)
    idx = (len(s)-1)*p/100
    lo, hi = int(idx), min(int(idx)+1, len(s)-1)
    return s[lo] + (s[hi]-s[lo])*(idx-lo)

# ═══════════════════════════════════════════════════════════════════════════════
# PHẦN 1 — GARCH(1,1) VOLATILITY FORECAST
# ═══════════════════════════════════════════════════════════════════════════════
#
# Mô hình: σ²_t = ω + α·r²_{t-1} + β·σ²_{t-1}
#
# Ý nghĩa:
#   σ²_t  = forecast variance ngày t
#   ω     = baseline variance (long-run mean component)
#   α     = weight của shock hôm qua (r²_{t-1}) — "ARCH effect"
#   β     = persistence từ variance hôm qua — "GARCH effect"
#   α + β < 1 → stationary (variance không diverge)
#
# Variance targeting: ω = σ²_bar × (1 - α - β)
# → chỉ cần tìm (α, β), ω tính được từ sample variance

def garch_loglik(returns, omega, alpha, beta):
    """Log-likelihood của GARCH(1,1) với Gaussian innovations"""
    n = len(returns)
    sigma2 = omega / (1 - alpha - beta)   # unconditional variance as initial
    ll = 0.0
    for r in returns:
        if sigma2 <= 0:
            sigma2 = 1e-8
        ll += -0.5 * (math.log(2*math.pi) + math.log(sigma2) + r**2/sigma2)
        sigma2 = omega + alpha*r**2 + beta*sigma2
    return ll

def fit_garch(returns):
    """
    Fit GARCH(1,1) bằng variance targeting + grid search trên (alpha, beta).
    Nhanh hơn full MLE vì chỉ search 2D thay vì 3D.
    """
    if len(returns) < 50:
        return None

    # Sample variance (long-run target)
    var_bar = sum(r**2 for r in returns) / len(returns)

    best_ll = -math.inf
    best = (0.08, 0.88)   # GARCH(1,1) typical values

    # Grid search: alpha ∈ [0.01, 0.30], beta ∈ [0.50, 0.97]
    alphas = [i*0.01 for i in range(1, 31)]
    betas  = [0.50 + i*0.01 for i in range(48)]

    for alpha in alphas:
        for beta in betas:
            if alpha + beta >= 0.999:
                continue
            omega = var_bar * (1 - alpha - beta)
            if omega <= 0:
                continue
            try:
                ll = garch_loglik(returns, omega, alpha, beta)
                if ll > best_ll:
                    best_ll = ll
                    best = (alpha, beta)
            except:
                continue

    alpha, beta = best
    omega = var_bar * (1 - alpha - beta)
    return omega, alpha, beta

def garch_forecast(returns, omega, alpha, beta, horizon=1):
    """
    Forecast variance cho h steps ahead.
    h=1: σ²_{T+1} = ω + α·r²_T + β·σ²_T
    h>1: σ²_{T+h} = ω/(1-α-β) + (α+β)^(h-1) × (σ²_{T+1} - ω/(1-α-β))
    """
    # Tính sigma2 tại T (cuối chuỗi)
    sigma2 = omega / (1 - alpha - beta)
    for r in returns:
        sigma2 = omega + alpha*r**2 + beta*sigma2

    if horizon == 1:
        return sigma2

    # Multi-step forecast
    sigma2_lt = omega / (1 - alpha - beta)   # long-term variance
    persist = alpha + beta
    sigma2_h = sigma2_lt + persist**(horizon-1) * (sigma2 - sigma2_lt)
    return sigma2_h

def run_garch(ticker, capital_pct=1.0):
    """
    Chạy GARCH cho 1 mã, trả dict kết quả.
    capital_pct: % vốn dự kiến vào lệnh (để tính VaR tiền mặt)
    """
    print(f'  [GARCH] Fetch {ticker}...', file=sys.stderr)
    rets = fetch_returns(ticker, years=3)
    if len(rets) < 100:
        return {'error': 'insufficient data', 'ticker': ticker}

    print(f'  [GARCH] Fitting {ticker} ({len(rets)} bars)...', file=sys.stderr)
    params = fit_garch(rets)
    if params is None:
        return {'error': 'fit failed', 'ticker': ticker}

    omega, alpha, beta = params
    sigma2_1  = garch_forecast(rets, omega, alpha, beta, horizon=1)
    sigma2_5  = garch_forecast(rets, omega, alpha, beta, horizon=5)
    sigma2_lt = omega / (1 - alpha - beta)

    vol_1d   = math.sqrt(sigma2_1)    # % / ngày
    vol_5d   = math.sqrt(sigma2_5)    # % / ngày (5-day ahead)
    vol_lt   = math.sqrt(sigma2_lt)   # long-term daily vol

    # Historical comparison
    hist_vol = math.sqrt(sum(r**2 for r in rets[-20:])/20)

    # Suggested SL distance (2× forecast vol → 95% không bị stopped out by noise)
    sl_pct_tight  = vol_1d * 1.5   # tight stop
    sl_pct_normal = vol_1d * 2.0   # normal stop
    sl_pct_wide   = vol_1d * 3.0   # wide stop (long-term)

    # Position size based on GARCH vol (risk 1% capital)
    risk_amt = CAPITAL * 0.01
    # size_by_vol = risk / (vol_1d/100) → số tiền
    pos_size_1pct_tight  = risk_amt / (sl_pct_tight/100)
    pos_size_1pct_normal = risk_amt / (sl_pct_normal/100)

    # Regime: so sánh vol hiện tại vs long-term
    vol_ratio = vol_1d / vol_lt
    if vol_ratio > 1.5:
        vol_regime = 'HIGH_VOL'   # thị trường đang biến động mạnh
    elif vol_ratio < 0.7:
        vol_regime = 'LOW_VOL'    # thị trường yên tĩnh
    else:
        vol_regime = 'NORMAL'

    return {
        'ticker'         : ticker,
        'n_bars'         : len(rets),
        # GARCH params
        'omega'          : round(omega, 6),
        'alpha'          : round(alpha, 4),
        'beta'           : round(beta, 4),
        'persistence'    : round(alpha + beta, 4),
        # Forecasts
        'vol_1d_pct'     : round(vol_1d, 3),      # forecast vol ngày mai (%)
        'vol_5d_pct'     : round(vol_5d, 3),       # forecast vol 5 ngày tới
        'vol_lt_pct'     : round(vol_lt, 3),       # long-term vol
        'vol_hist20_pct' : round(hist_vol, 3),     # realized vol 20 ngày qua
        'vol_regime'     : vol_regime,
        'vol_ratio'      : round(vol_ratio, 2),
        # Stop distance gợi ý
        'sl_tight_pct'   : round(sl_pct_tight, 2),
        'sl_normal_pct'  : round(sl_pct_normal, 2),
        'sl_wide_pct'    : round(sl_pct_wide, 2),
        # Position size (VND)
        'pos_size_tight' : round(pos_size_1pct_tight/1e6, 2),   # triệu VND
        'pos_size_normal': round(pos_size_1pct_normal/1e6, 2),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# PHẦN 2 — MONTE CARLO TRADE SIMULATION
# ═══════════════════════════════════════════════════════════════════════════════
#
# Simulate N_SIM đường equity curve (mỗi đường = sequence ngẫu nhiên M trades)
# Dùng historical trade stats từ journal.db hoặc input thủ công.
#
# Output:
#   - P(profitable after M trades)
#   - Median equity, 5th/95th percentile
#   - Expected max drawdown distribution
#   - Consecutive loss distribution (risk of ruin estimate)

N_SIM = 10_000

def load_trade_stats_from_db():
    """Đọc win_rate, avg_win%, avg_loss% từ journal.db"""
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT pnl_r FROM trades WHERE status='CLOSED' AND pnl_r IS NOT NULL"
        ).fetchall()
        conn.close()
        if len(rows) < 10:
            return None
        rs = [r[0] for r in rows]
        wins  = [r for r in rs if r > 0]
        loses = [r for r in rs if r <= 0]
        return {
            'n_trades'  : len(rs),
            'win_rate'  : len(wins)/len(rs),
            'avg_win_r' : mean(wins)   if wins  else 1.5,
            'avg_loss_r': mean(loses)  if loses else -1.0,
            'source'    : 'journal.db'
        }
    except:
        return None

def simulate_equity_curve(win_rate, avg_win_r, avg_loss_r,
                           n_trades, n_sim=N_SIM, risk_per_trade=0.01):
    """
    Simulate n_sim equity curves, mỗi curve = n_trades lệnh.
    risk_per_trade: % vốn risk mỗi lệnh (default 1%)

    Returns dict thống kê phân phối kết quả.
    """
    random.seed(42)
    final_equity   = []
    max_drawdowns  = []
    max_consec_loss= []
    time_underwater= []   # % trades dưới đỉnh equity

    for _ in range(n_sim):
        equity = 1.0   # normalized (1 = 100% vốn)
        peak   = 1.0
        max_dd = 0.0
        consec_loss = 0; max_cl = 0
        under_count = 0

        for _ in range(n_trades):
            if random.random() < win_rate:
                ret = avg_win_r * risk_per_trade
                consec_loss = 0
            else:
                ret = avg_loss_r * risk_per_trade   # avg_loss_r là số âm
                consec_loss += 1
                max_cl = max(max_cl, consec_loss)

            equity *= (1 + ret)
            if equity > peak:
                peak = equity
            dd = (peak - equity) / peak
            max_dd = max(max_dd, dd)
            if equity < peak:
                under_count += 1

        final_equity.append(equity)
        max_drawdowns.append(max_dd)
        max_consec_loss.append(max_cl)
        time_underwater.append(under_count / n_trades)

    # Tính thống kê
    p_profit = sum(1 for e in final_equity if e > 1.0) / n_sim

    return {
        'n_sim'         : n_sim,
        'n_trades'      : n_trades,
        'win_rate'      : round(win_rate*100, 1),
        'avg_win_r'     : round(avg_win_r, 2),
        'avg_loss_r'    : round(avg_loss_r, 2),
        'profit_factor' : round(win_rate*avg_win_r / abs((1-win_rate)*avg_loss_r), 2),
        # Equity distribution (%)
        'p_profit_pct'  : round(p_profit*100, 1),
        'median_return' : round((percentile(final_equity,50)-1)*100, 1),
        'p5_return'     : round((percentile(final_equity,5)-1)*100, 1),
        'p95_return'    : round((percentile(final_equity,95)-1)*100, 1),
        'p1_return'     : round((percentile(final_equity,1)-1)*100, 1),   # worst 1%
        # Drawdown distribution (%)
        'median_maxdd'  : round(percentile(max_drawdowns,50)*100, 1),
        'p95_maxdd'     : round(percentile(max_drawdowns,95)*100, 1),
        'expected_maxdd': round(mean(max_drawdowns)*100, 1),
        # Consecutive losses
        'median_consec_loss': round(percentile(max_consec_loss,50), 0),
        'p95_consec_loss'   : round(percentile(max_consec_loss,95), 0),
        # Time underwater
        'pct_time_under': round(mean(time_underwater)*100, 1),
    }

def run_monte_carlo(wr=None, avg_win=None, avg_loss=None, n_trades=50):
    """Chạy Monte Carlo, tự load DB nếu không có params"""
    stats = None
    if wr is None:
        stats = load_trade_stats_from_db()

    if stats:
        win_rate  = stats['win_rate']
        avg_win_r = stats['avg_win_r']
        avg_loss_r= stats['avg_loss_r']
        source    = stats['source']
        n_hist    = stats['n_trades']
    else:
        # Dùng backtest defaults nếu không có DB
        win_rate   = (wr or 40) / 100
        avg_win_r  = avg_win  or 1.8
        avg_loss_r = -(avg_loss or 1.0)
        source     = 'manual_input'
        n_hist     = 0

    print(f'  [MC] Simulating {N_SIM:,} paths × {n_trades} trades '
          f'(WR={win_rate*100:.0f}%, source={source})...', file=sys.stderr)

    result = simulate_equity_curve(win_rate, avg_win_r, avg_loss_r, n_trades)
    result['source'] = source
    result['n_historical_trades'] = n_hist
    return result


# ═══════════════════════════════════════════════════════════════════════════════
# PHẦN 3 — VALUE AT RISK (VaR)
# ═══════════════════════════════════════════════════════════════════════════════
#
# 2 phương pháp:
#   1. Historical VaR: lấy percentile 5% từ realized returns (không giả định phân phối)
#   2. GARCH VaR: dùng GARCH forecast vol × z-score (parametric, forward-looking)
#
# Portfolio VaR (simplified — không dùng covariance matrix):
#   VaR_portfolio ≈ Σ (weight_i × VaR_i)   [conservative, assumes correlation=1]
#   Hoặc dùng diversification factor nếu user muốn

def compute_var(returns, confidence=0.95, horizon=1, method='both',
                omega=None, alpha=None, beta=None):
    """
    Tính VaR cho 1 chuỗi returns.

    Returns dict với:
        historical_var: percentile-based (no distribution assumption)
        garch_var:      parametric dùng GARCH forecast vol
        expected_shortfall: CVaR (average loss beyond VaR threshold)
    """
    z_score = {0.90: 1.282, 0.95: 1.645, 0.99: 2.326}.get(confidence, 1.645)
    alpha_pct = (1 - confidence) * 100

    result = {'confidence': confidence, 'horizon_days': horizon}

    # ── Historical VaR ──────────────────────────────────────────────────────
    # 1-day VaR
    hist_var_1d = -percentile(returns, alpha_pct)   # dương = mức lỗ
    # Scale to horizon: VaR_h = VaR_1d × sqrt(h)  [square root of time rule]
    hist_var_h  = hist_var_1d * math.sqrt(horizon)
    # Expected Shortfall (CVaR): mean của returns < -VaR
    threshold = -hist_var_1d
    tail_losses = [-r for r in returns if r < threshold]
    es = mean(tail_losses) if tail_losses else hist_var_1d * 1.2

    result.update({
        'hist_var_1d_pct'  : round(hist_var_1d, 3),
        'hist_var_h_pct'   : round(hist_var_h, 3),
        'expected_shortfall': round(es, 3),
    })

    # ── GARCH VaR (nếu có params) ────────────────────────────────────────────
    if omega and alpha and beta:
        # Forecast vol từ GARCH
        sigma2_1d = garch_forecast(returns, omega, alpha, beta, horizon=1)
        sigma2_h  = garch_forecast(returns, omega, alpha, beta, horizon=horizon)

        mu = mean(returns[-20:])   # drift estimate (20-day mean)
        garch_var_1d = -(mu - z_score * math.sqrt(sigma2_1d))
        garch_var_h  = -(mu * horizon - z_score * math.sqrt(sigma2_h * horizon))

        result.update({
            'garch_var_1d_pct': round(garch_var_1d, 3),
            'garch_var_h_pct' : round(garch_var_h, 3),
            'forecast_vol_1d' : round(math.sqrt(sigma2_1d), 3),
            'forecast_vol_h'  : round(math.sqrt(sigma2_h), 3),
        })

    return result

def run_var(tickers, weights=None, confidence=0.95, horizon=1):
    """
    Tính VaR cho danh mục nhiều mã.
    weights: list[float] tổng = 1.0 (mặc định equal weight)
    """
    if not tickers:
        # Đọc từ DB nếu không có input
        try:
            conn = sqlite3.connect(DB_PATH)
            rows = conn.execute(
                "SELECT ticker, risk_pct FROM trades WHERE status='OPEN'"
            ).fetchall()
            conn.close()
            tickers = [r[0] for r in rows]
            weights = [r[1]/100 for r in rows] if rows else []
        except:
            pass

    if not tickers:
        return {'error': 'no tickers provided'}

    n = len(tickers)
    if weights is None or len(weights) != n:
        weights = [1/n] * n

    print(f'  [VaR] Computing portfolio VaR: {tickers}', file=sys.stderr)

    individual = {}
    for ticker, w in zip(tickers, weights):
        print(f'  [VaR] Fetch + GARCH {ticker}...', file=sys.stderr)
        rets = fetch_returns(ticker, years=2)
        if len(rets) < 50:
            individual[ticker] = {'error': 'insufficient data', 'weight': w}
            continue

        # Fit GARCH
        params = fit_garch(rets)
        if params:
            omega, alph, beta = params
            var_result = compute_var(rets, confidence, horizon,
                                     omega=omega, alpha=alph, beta=beta)
        else:
            var_result = compute_var(rets, confidence, horizon)

        var_result['weight'] = round(w, 4)
        individual[ticker] = var_result
        time.sleep(0.15)

    # Portfolio VaR (weighted sum — conservative, assumes ρ=1)
    valid = [(t, d) for t, d in individual.items() if 'error' not in d]

    port_hist_var_1d  = sum(d.get('hist_var_1d_pct', 0) * d['weight'] for _, d in valid)
    port_garch_var_1d = sum(d.get('garch_var_1d_pct', 0) * d['weight'] for _, d in valid)
    port_es           = sum(d.get('expected_shortfall', 0) * d['weight'] for _, d in valid)

    # Tiền mặt (VND)
    port_var_vnd_hist  = port_hist_var_1d  / 100 * CAPITAL
    port_var_vnd_garch = port_garch_var_1d / 100 * CAPITAL

    return {
        'tickers'       : tickers,
        'weights'       : weights,
        'confidence'    : confidence,
        'horizon_days'  : horizon,
        'individual'    : individual,
        'portfolio': {
            'hist_var_1d_pct'  : round(port_hist_var_1d, 3),
            'garch_var_1d_pct' : round(port_garch_var_1d, 3),
            'expected_shortfall': round(port_es, 3),
            'hist_var_vnd_m'   : round(port_var_vnd_hist/1e6, 3),    # triệu VND
            'garch_var_vnd_m'  : round(port_var_vnd_garch/1e6, 3),
            'interpretation'   : (
                f"Với {confidence*100:.0f}% confidence, danh mục không lỗ quá "
                f"{port_garch_var_1d:.2f}% ({port_var_vnd_garch/1e6:.2f} triệu VND) "
                f"trong 1 ngày."
            )
        }
    }


# ═══════════════════════════════════════════════════════════════════════════════
# PRETTY PRINT CHO SKILLS
# ═══════════════════════════════════════════════════════════════════════════════

def print_garch(g):
    if 'error' in g:
        print(f'\n⚠️  GARCH {g["ticker"]}: {g["error"]}')
        return
    regime_icon = {'HIGH_VOL': '🔴', 'NORMAL': '🟡', 'LOW_VOL': '🟢'}.get(g['vol_regime'], '⚪')
    print(f"""
📊 GARCH VOLATILITY — {g['ticker']} ({g['n_bars']} bars)
  Params: α={g['alpha']}  β={g['beta']}  persist={g['persistence']} (α+β)

  Forecast vol ngày mai : {g['vol_1d_pct']:.2f}%/ngày  {regime_icon} {g['vol_regime']}
  Forecast vol 5 ngày   : {g['vol_5d_pct']:.2f}%/ngày
  Long-term vol         : {g['vol_lt_pct']:.2f}%/ngày
  Realized vol (20d)    : {g['vol_hist20_pct']:.2f}%/ngày  (vol ratio: {g['vol_ratio']}×)

  Gợi ý Stop Loss:
    Tight  (1.5×vol): {g['sl_tight_pct']:.2f}%   → pos size @1% risk: {g['pos_size_tight']:.1f}M VND
    Normal (2.0×vol): {g['sl_normal_pct']:.2f}%   → pos size @1% risk: {g['pos_size_normal']:.1f}M VND
    Wide   (3.0×vol): {g['sl_wide_pct']:.2f}%""")

def print_mc(mc):
    bar = lambda p: '█' * int(p/5) + '░' * (20-int(p/5))
    print(f"""
🎲 MONTE CARLO — {mc['n_sim']:,} simulations × {mc['n_trades']} lệnh
  Source: {mc['source']}  |  Win Rate: {mc['win_rate']}%  |  PF: {mc['profit_factor']}
  Avg Win: +{mc['avg_win_r']}R  |  Avg Loss: {mc['avg_loss_r']}R

  P(Profitable): {mc['p_profit_pct']:.1f}%  {bar(mc['p_profit_pct'])}

  Return Distribution sau {mc['n_trades']} lệnh:
    Worst 1%   :  {mc['p1_return']:+.1f}%
    5th pct    :  {mc['p5_return']:+.1f}%
    Median     :  {mc['median_return']:+.1f}%  ← kỳ vọng thực tế
    95th pct   :  {mc['p95_return']:+.1f}%

  Max Drawdown Distribution:
    Expected   : -{mc['expected_maxdd']:.1f}%  (trung bình qua {mc['n_sim']:,} paths)
    Median     : -{mc['median_maxdd']:.1f}%
    Worst 5%   : -{mc['p95_maxdd']:.1f}%   ← phải chịu được mức này

  Lỗ liên tiếp (consecutive losses):
    Median : {int(mc['median_consec_loss'])} lệnh  |  Worst 5%: {int(mc['p95_consec_loss'])} lệnh

  % thời gian "under water" (equity < peak): {mc['pct_time_under']:.1f}%""")

def print_var(v):
    if 'error' in v:
        print(f'\n⚠️  VaR: {v["error"]}')
        return
    p = v['portfolio']
    print(f"""
⚖️  VALUE AT RISK — {v['confidence']*100:.0f}% confidence, {v['horizon_days']}-day horizon
  Danh mục: {', '.join(v['tickers'])}

  Historical VaR  : -{p['hist_var_1d_pct']:.2f}%/ngày  ({p['hist_var_vnd_m']:.2f}M VND)
  GARCH VaR       : -{p['garch_var_1d_pct']:.2f}%/ngày  ({p['garch_var_vnd_m']:.2f}M VND)
  Expected Shortfall: -{p['expected_shortfall']:.2f}%/ngày  (CVaR — mean loss vượt VaR)

  → {p['interpretation']}

  Chi tiết từng mã:""")
    for tk, d in v['individual'].items():
        if 'error' in d:
            print(f'    {tk}: ⚠️ {d["error"]}')
        else:
            gvar = d.get('garch_var_1d_pct', 'N/A')
            gvar_str = f'{gvar:.2f}%' if isinstance(gvar, float) else gvar
            print(f'    {tk} (w={d["weight"]:.0%}): '
                  f'Hist VaR={d["hist_var_1d_pct"]:.2f}%  GARCH VaR={gvar_str}  '
                  f'Vol={d.get("forecast_vol_1d", d.get("vol_1d_pct", "N/A"))}%/d')


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN CLI
# ═══════════════════════════════════════════════════════════════════════════════

def parse_args():
    args = sys.argv[1:]
    cmd  = args[0] if args else 'all'
    rest = args[1:]

    # Parse flags
    wr       = None; rr = None; n_trades = 50
    tickers  = []
    for i, a in enumerate(rest):
        if a == '--wr'  and i+1 < len(rest): wr = float(rest[i+1])
        if a == '--rr'  and i+1 < len(rest): rr = float(rest[i+1])
        if a == '--n'   and i+1 < len(rest): n_trades = int(rest[i+1])
        if not a.startswith('--') and (i==0 or not rest[i-1].startswith('--')):
            tickers.append(a.upper())

    return cmd, tickers, wr, rr, n_trades

if __name__ == '__main__':
    cmd, tickers, wr, rr, n_trades = parse_args()

    output = {}

    if cmd in ('garch', 'all'):
        tks = tickers or ['VCB']
        for tk in tks:
            g = run_garch(tk)
            print_garch(g)
            output[f'garch_{tk}'] = g

    if cmd in ('mc', 'all'):
        mc = run_monte_carlo(wr=wr, avg_win=rr, n_trades=n_trades)
        print_mc(mc)
        output['monte_carlo'] = mc

    if cmd in ('var', 'all'):
        tks = tickers or []
        v = run_var(tks)
        print_var(v)
        output['var'] = v

    print('\n' + '='*60, file=sys.stderr)
    print(json.dumps(output, ensure_ascii=False))
