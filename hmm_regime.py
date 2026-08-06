"""
HMM Regime Detector â€” Lightweight CLI tool cho skills gá»i.
Output JSON Ä‘á»ƒ skills parse.
Cache vÃ o SQLite (journal.db) â€” chá»‰ re-train náº¿u cache > 1 ngÃ y cÅ©.

Usage:
    python hmm_regime.py VCB
    python hmm_regime.py VCB MWG STB
    python hmm_regime.py --all          # toÃ n watchlist
    python hmm_regime.py --vnindex      # VNINDEX proxy

Output (JSON):
    {
      "VCB": {
        "regime": "BULL",
        "regime_idx": 1,
        "prob_bull": 0.821,
        "prob_bear": 0.046,
        "prob_sideways": 0.133,
        "mu": [+0.07, +0.43],      # [bear_mu, bull_mu] %/day
        "sigma": [4.13, 1.12],
        "persistence_bull": 0.821,
        "recent_path": "BBBBBSSBBBBBBBBBBBBBBBBBBBBBBB",  # B/S/W last 30 days
        "cached": false
      }
    }
"""

import sys, json, math, os, sqlite3, time, urllib.request, random
from datetime import datetime, date
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')

DB_PATH   = Path(__file__).parent / "journal.db"
CACHE_TTL = 24 * 3600   # re-train náº¿u cache > 24h
N_STATES  = 3
N_ITER    = 60

WATCHLIST = [
    'GMD','ACB','VND','OCB','HCM',
]
VNINDEX_PROXY = ['VCB','SSI','VNM']   # VNIndex khÃ´ng cÃ³ trÃªn Yahoo VN trá»±c tiáº¿p

random.seed(42)

# â”€â”€ Gaussian helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def gpdf(x, mu, sigma):
    sigma = max(sigma, 1e-6)
    return (1/(sigma*math.sqrt(2*math.pi)))*math.exp(-0.5*((x-mu)/sigma)**2)

def lgpdf(x, mu, sigma):
    sigma = max(sigma, 1e-6)
    return -math.log(sigma)-0.5*math.log(2*math.pi)-0.5*((x-mu)/sigma)**2

# â”€â”€ HMM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class HMM:
    def __init__(self, n=3):
        self.n = n
        self.pi = [1/n]*n
        self.A  = [[0.9 if i==j else 0.1/(n-1) for j in range(n)] for i in range(n)]
        self.mu = [0.]*n; self.sg = [1.]*n

    def _init(self, obs):
        s = sorted(obs); T = len(s); c = T//self.n
        for i in range(self.n):
            seg = s[i*c:(i+1)*c] if i < self.n-1 else s[i*c:]
            m = sum(seg)/len(seg)
            v = sum((x-m)**2 for x in seg)/len(seg)
            self.mu[i] = m; self.sg[i] = math.sqrt(v) if v>0 else 0.01

    def forward(self, obs):
        T=len(obs); n=self.n
        a=[[0.]*n for _ in range(T)]; sc=[0.]*T
        for i in range(n): a[0][i]=self.pi[i]*gpdf(obs[0],self.mu[i],self.sg[i])
        sc[0]=sum(a[0]) or 1e-300; a[0]=[x/sc[0] for x in a[0]]
        for t in range(1,T):
            for j in range(n):
                a[t][j]=sum(a[t-1][i]*self.A[i][j] for i in range(n))*gpdf(obs[t],self.mu[j],self.sg[j])
            sc[t]=sum(a[t]) or 1e-300; a[t]=[x/sc[t] for x in a[t]]
        return a,sc

    def backward(self, obs, sc):
        T=len(obs); n=self.n
        b=[[1.]*n for _ in range(T)]
        for t in range(T-2,-1,-1):
            for i in range(n):
                b[t][i]=sum(self.A[i][j]*gpdf(obs[t+1],self.mu[j],self.sg[j])*b[t+1][j] for j in range(n))
            b[t]=[x/sc[t+1] for x in b[t]]
        return b

    def viterbi(self, obs):
        T=len(obs); n=self.n
        d=[[-math.inf]*n for _ in range(T)]; ps=[[0]*n for _ in range(T)]
        for i in range(n): d[0][i]=math.log(self.pi[i]+1e-300)+lgpdf(obs[0],self.mu[i],self.sg[i])
        for t in range(1,T):
            for j in range(n):
                bi=max(range(n),key=lambda i:d[t-1][i]+math.log(self.A[i][j]+1e-300))
                d[t][j]=d[t-1][bi]+math.log(self.A[bi][j]+1e-300)+lgpdf(obs[t],self.mu[j],self.sg[j])
                ps[t][j]=bi
        path=[0]*T; path[T-1]=max(range(n),key=lambda i:d[T-1][i])
        for t in range(T-2,-1,-1): path[t]=ps[t+1][path[t+1]]
        return path

    def fit(self, obs, n_iter=N_ITER, tol=1e-4):
        self._init(obs)
        T=len(obs); n=self.n; prev=-math.inf
        for _ in range(n_iter):
            a,sc=self.forward(obs); b=self.backward(obs,sc)
            # gamma
            gm=[]
            for t in range(T):
                g=[a[t][i]*b[t][i] for i in range(n)]; tot=sum(g) or 1e-300
                gm.append([x/tot for x in g])
            # xi
            xi=[]
            for t in range(T-1):
                xt=[[0.]*n for _ in range(n)]; den=0.
                for i in range(n):
                    for j in range(n):
                        v=a[t][i]*self.A[i][j]*gpdf(obs[t+1],self.mu[j],self.sg[j])*b[t+1][j]
                        xt[i][j]=v; den+=v
                den=den or 1e-300
                for i in range(n):
                    for j in range(n): xt[i][j]/=den
                xi.append(xt)
            # M-step
            self.pi=gm[0][:]
            for i in range(n):
                di=sum(gm[t][i] for t in range(T-1)) or 1e-300
                for j in range(n): self.A[i][j]=sum(xi[t][i][j] for t in range(T-1))/di
                rs=sum(self.A[i]) or 1e-300; self.A[i]=[x/rs for x in self.A[i]]
            for i in range(n):
                di=sum(gm[t][i] for t in range(T)) or 1e-300
                self.mu[i]=sum(gm[t][i]*obs[t] for t in range(T))/di
                v=sum(gm[t][i]*(obs[t]-self.mu[i])**2 for t in range(T))/di
                self.sg[i]=math.sqrt(v) if v>1e-9 else 1e-4
            ll=sum(math.log(s+1e-300) for s in sc)
            if abs(ll-prev)<tol and _>5: break
            prev=ll
        return self

    def sort_by_mean(self):
        """Sort: state 0=BEAR(lowest mean), 1=SIDEWAYS, 2=BULL(highest mean)"""
        od=sorted(range(self.n),key=lambda i:self.mu[i])
        self.mu=[self.mu[i] for i in od]; self.sg=[self.sg[i] for i in od]
        self.pi=[self.pi[i] for i in od]
        self.A=[[self.A[od[i]][od[j]] for j in range(self.n)] for i in range(self.n)]

    def current_probs(self, obs):
        """XÃ¡c suáº¥t tráº¡ng thÃ¡i hiá»‡n táº¡i tá»« alpha[-1]"""
        a,_=self.forward(obs)
        return a[-1]   # [p_state0, p_state1, p_state2] sau sort = [bear, sw, bull]

# â”€â”€ Fetch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def fetch_returns(ticker):
    url=(f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}.VN'
         f'?interval=1d&range=5y')
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req,timeout=12) as r:
            d=json.loads(r.read())
        cs=d['chart']['result'][0]['indicators']['quote'][0]['close']
        cs=[c for c in cs if c and c>0]
        return [(cs[i]/cs[i-1]-1)*100 for i in range(1,len(cs))]
    except: return []

# â”€â”€ SQLite cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def ensure_table(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS hmm_regime_cache (
        ticker TEXT PRIMARY KEY,
        regime TEXT,
        prob_bull REAL, prob_bear REAL, prob_sideways REAL,
        mu_bull REAL, mu_bear REAL, sg_bull REAL, sg_bear REAL,
        persistence_bull REAL,
        recent_path TEXT,
        updated_at TEXT
    )''')
    conn.commit()

def load_cache(conn, ticker):
    r=conn.execute('SELECT *,updated_at FROM hmm_regime_cache WHERE ticker=?',(ticker,)).fetchone()
    if not r: return None
    updated=datetime.fromisoformat(r['updated_at'])
    if (datetime.now()-updated).total_seconds()>CACHE_TTL: return None
    return r

def save_cache(conn, ticker, result):
    conn.execute('''INSERT OR REPLACE INTO hmm_regime_cache
        (ticker,regime,prob_bull,prob_bear,prob_sideways,
         mu_bull,mu_bear,sg_bull,sg_bear,persistence_bull,recent_path,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'))''',
        (ticker,result['regime'],result['prob_bull'],result['prob_bear'],
         result['prob_sideways'],result['mu_bull'],result['mu_bear'],
         result['sg_bull'],result['sg_bear'],result['persistence_bull'],
         result['recent_path']))
    conn.commit()

# â”€â”€ Analyse single ticker â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

def analyse(ticker, conn, force=False):
    if not force:
        cached=load_cache(conn,ticker)
        if cached:
            return {
                'regime':cached['regime'],
                'prob_bull':cached['prob_bull'],
                'prob_bear':cached['prob_bear'],
                'prob_sideways':cached['prob_sideways'],
                'mu_bull':cached['mu_bull'], 'mu_bear':cached['mu_bear'],
                'sg_bull':cached['sg_bull'], 'sg_bear':cached['sg_bear'],
                'persistence_bull':cached['persistence_bull'],
                'recent_path':cached['recent_path'],
                'cached':True
            }

    rets=fetch_returns(ticker)
    if len(rets)<100:
        return {'regime':'N/A','error':'insufficient data','cached':False}

    hmm=HMM(N_STATES)
    hmm.fit(rets)
    hmm.sort_by_mean()   # 0=BEAR,1=SIDEWAYS,2=BULL

    path=hmm.viterbi(rets)
    probs=hmm.current_probs(rets)  # [bear,sw,bull]

    state_map={0:'BEAR',1:'SIDEWAYS',2:'BULL'}
    regime=state_map[path[-1]]

    # Recent path string (last 30 days)
    char_map={0:'R',1:'S',2:'G'}   # Red/Sideways/Green
    recent_path=''.join(char_map[s] for s in path[-30:])

    result={
        'regime':regime,
        'prob_bull':round(probs[2],3),
        'prob_bear':round(probs[0],3),
        'prob_sideways':round(probs[1],3),
        'mu_bull':round(hmm.mu[2],4),
        'mu_bear':round(hmm.mu[0],4),
        'sg_bull':round(hmm.sg[2],4),
        'sg_bear':round(hmm.sg[0],4),
        'persistence_bull':round(hmm.A[2][2],3),
        'recent_path':recent_path,
        'cached':False
    }
    save_cache(conn,ticker,result)
    return result

# â”€â”€ Format output cho skill Ä‘á»c â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

REGIME_ICON={'BULL':'ðŸŸ¢','SIDEWAYS':'ðŸŸ¡','BEAR':'ðŸ”´','N/A':'âšª'}

def format_for_skill(ticker, r):
    """Tráº£ 1 dÃ²ng ngáº¯n cho skill embed vÃ o output"""
    if r.get('error'):
        return f'HMM {ticker}: âšª N/A ({r["error"]})'
    icon=REGIME_ICON[r['regime']]
    cached_tag=' [cached]' if r['cached'] else ''
    path30=r.get('recent_path','')
    # Visual: G=ðŸŸ¢ R=ðŸ”´ S=ðŸŸ¡ (5 chars groups)
    visual=path30[-10:].replace('G','â–²').replace('R','â–¼').replace('S','â”€')
    return (f'HMM {ticker}: {icon} {r["regime"]:10s} '
            f'| P(Bull)={r["prob_bull"]:.0%} P(Bear)={r["prob_bear"]:.0%} '
            f'| Î¼_bull={r["mu_bull"]:+.2f}%/d '
            f'| Recent: {visual}{cached_tag}')

# â”€â”€ MAIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

if __name__=='__main__':
    args=sys.argv[1:]
    force='--force' in args; args=[a for a in args if not a.startswith('--')]

    if '--all' in sys.argv:
        tickers=WATCHLIST
    elif '--vnindex' in sys.argv:
        tickers=VNINDEX_PROXY
    elif args:
        tickers=[t.upper() for t in args]
    else:
        print('Usage: python hmm_regime.py TICKER [TICKER2 ...] [--force]')
        sys.exit(1)

    try:
        conn=sqlite3.connect(DB_PATH); conn.row_factory=sqlite3.Row
    except:
        # Fallback: in-memory DB náº¿u khÃ´ng cÃ³ journal.db
        conn=sqlite3.connect(':memory:'); conn.row_factory=sqlite3.Row
    ensure_table(conn)

    results={}
    for tk in tickers:
        r=analyse(tk,conn,force=force)
        results[tk]=r
        print(format_for_skill(tk,r), file=sys.stderr)   # progress â†’ stderr
        if not r.get('cached'): time.sleep(0.2)

    # JSON output â†’ stdout (Ä‘á»ƒ skill parse)
    print(json.dumps(results,ensure_ascii=False))

