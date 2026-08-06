import requests, datetime, sys

TICKERS = [
    'GMD','ACB','VND','OCB','HCM'
]

def fetch(t):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{t}.VN'
    try:
        r = requests.get(url, params={'interval':'1d','range':'6mo'},
                         headers={'User-Agent':'Mozilla/5.0'}, timeout=12)
        d = r.json()['chart']['result'][0]
        q = d['indicators']['quote'][0]
        ts = d['timestamp']
        bars = []
        for i in range(len(ts)):
            o,h,l,c,v = q['open'][i],q['high'][i],q['low'][i],q['close'][i],q['volume'][i]
            if None in (o,h,l,c,v) or h<=l: continue
            bars.append({'o':o,'h':h,'l':l,'c':c,'v':v})
        return bars if len(bars)>=25 else None
    except:
        return None

def sma_s(arr, n):
    out=[None]*len(arr)
    for i in range(n-1,len(arr)):
        out[i]=sum(arr[i-n+1:i+1])/n
    return out

def delta_p(b):
    return (2*(b['c']-b['l'])/(b['h']-b['l'])-1)*100 if b['h']!=b['l'] else 0

def close_pos(b):
    return (b['c']-b['l'])/(b['h']-b['l'])*100 if b['h']!=b['l'] else 50

def find_pivots(bars, lb=3):
    phs,pls=[],[]
    n=len(bars)
    for i in range(lb,n-lb):
        if all(bars[i]['h']>=bars[j]['h'] for j in range(i-lb,i+lb+1) if j!=i):
            phs.append((i,bars[i]['h']))
        if all(bars[i]['l']<=bars[j]['l'] for j in range(i-lb,i+lb+1) if j!=i):
            pls.append((i,bars[i]['l']))
    return phs,pls

def wave(bars):
    n=min(30,len(bars))
    sub=bars[-n:]
    highs=[b['h'] for b in sub]
    lows=[b['l'] for b in sub]
    closes=[b['c'] for b in sub]
    curr=closes[-1]
    max_h=max(highs); min_l=min(lows)
    rng=(max_h-min_l)/min_l*100 if min_l>0 else 0
    phs,pls=find_pivots(sub,lb=3)
    if len(phs)<2 or len(pls)<2:
        if rng<8:
            pos=(curr-min_l)/(max_h-min_l)*100 if max_h>min_l else 50
            lbl='SW-bot' if pos<33 else ('SW-top' if pos>66 else 'SW-mid')
            return dict(struct='SIDEWAYS',label=lbl,bonus=0,sup=min_l,res=max_h)
        return dict(struct='MIXED',label='MIXED',bonus=0,sup=min_l,res=max_h)
    ph1=phs[-1][1]; ph2=phs[-2][1]
    pl1=pls[-1][1]; pl2=pls[-2][1]
    if rng<8:
        pos=(curr-min_l)/(max_h-min_l)*100 if max_h>min_l else 50
        lbl='SW-bot' if pos<33 else ('SW-top' if pos>66 else 'SW-mid')
        return dict(struct='SIDEWAYS',label=lbl,bonus=0,sup=min_l,res=max_h)
    up=ph1>ph2 and pl1>pl2
    dn=ph1<ph2 and pl1<pl2
    if up:
        if curr>ph1:
            return dict(struct='UPTREND',label='UP-IMPULSE',bonus=-5,sup=pl1,res=ph1)
        depth=(ph1-curr)/(ph1-pl1)*100 if ph1>pl1 else 0
        if depth<38:   lbl=f'UP-PBshal({depth:.0f}%)'; bon=3
        elif depth<=61: lbl=f'UP-PB-OK({depth:.0f}%)';  bon=5
        else:           lbl=f'UP-PBdeep({depth:.0f}%)'; bon=-5
        return dict(struct='UPTREND',label=lbl,bonus=bon,sup=pl1,res=ph1)
    elif dn:
        bnc=(curr-pl1)/(ph1-pl1)*100 if ph1>pl1 else 0
        if bnc<38:   lbl=f'DN-WEAK({bnc:.0f}%)';   bon=-15
        elif bnc<61: lbl=f'DN-BOUNCE({bnc:.0f}%)'; bon=-8
        else:        lbl=f'DN-STR({bnc:.0f}%)';    bon=-3
        return dict(struct='DOWNTREND',label=lbl,bonus=bon,sup=pl1,res=ph1)
    pos=(curr-min_l)/(max_h-min_l)*100 if max_h>min_l else 50
    return dict(struct='MIXED',label=f'MIXED({pos:.0f}%)',bonus=0,sup=min_l,res=max_h)

def score_t(bars):
    if len(bars)<25: return None
    closes=[b['c'] for b in bars]
    vols=[b['v'] for b in bars]
    n100=min(100,len(bars))
    ma20=sma_s(closes,20)
    ma100=sma_s(closes,n100)
    if ma100[-1] is None:
        ma100=sma_s(closes,min(50,len(bars)))
    curr=closes[-1]
    last=bars[-1]
    m20=ma20[-1]; m100=ma100[-1]
    if m20 is None or m100 is None: return None
    cum_d=sum(delta_p(b) for b in bars[-5:])
    cp=close_pos(last)
    avg_vol=sum(vols[-21:-1])/20 if len(vols)>=21 else sum(vols[:-1])/max(len(vols)-1,1)
    vol_r=last['v']/avg_vol if avg_vol>0 else 1
    m100_5=ma100[-6] if len(ma100)>=6 and ma100[-6] else m100
    slope=(m100/m100_5-1)*100 if m100_5 else 0
    w=wave(bars)
    reject=False; rej_r=''
    if curr<m20:
        reject=True; rej_r=f'Price<SMA20({m20:,.0f})'
    if w['struct']=='DOWNTREND' and w['bonus']<=-15:
        reject=True; rej_r=(rej_r+'+DN' if rej_r else 'DN-WEAK')
    c1=cum_d>0; c2=curr>m20; c3=m20>m100; c4=cp>=50
    c5=vol_r>=0.8; c6=slope>0.3; c7=w['struct']!='DOWNTREND'
    raw=sum([c1,c2,c3,c4,c5,c6,c7])/7*100
    sc=min(100,max(0,raw+w['bonus']))
    if reject:   sig='LOAI'
    elif sc>=71: sig='BUY'
    elif sc>=43: sig='WATCH'
    else:        sig='AVOID'
    return dict(sig=sig,score=sc,price=curr,m20=m20,m100=m100,
                cum_d=cum_d,cp=cp,vol_r=vol_r,slope=slope,
                wave=w,reject=reject,rej_r=rej_r,
                chg=(curr/closes[-2]-1)*100 if len(closes)>=2 else 0,
                crit=[c1,c2,c3,c4,c5,c6,c7])

def pr(s):
    sys.stdout.write(s+'\n')
    sys.stdout.flush()

pr('Fetching HOSE data...')
raw={}
for t in TICKERS:
    b=fetch(t)
    if b: raw[t]=b; sys.stdout.write(f'OK {t} ')
    else:            sys.stdout.write(f'XX {t} ')
    sys.stdout.flush()

pr(f'\n\nLoaded: {len(raw)}/{len(TICKERS)}\n')
res={}
for t,bars in raw.items():
    r=score_t(bars)
    if r: res[t]=r

buy  =sorted([(t,r) for t,r in res.items() if r['sig']=='BUY'],  key=lambda x:-x[1]['score'])
watch=sorted([(t,r) for t,r in res.items() if r['sig']=='WATCH'], key=lambda x:-x[1]['score'])
avoid=sorted([(t,r) for t,r in res.items() if r['sig']=='AVOID'], key=lambda x:-x[1]['score'])
loai =sorted([(t,r) for t,r in res.items() if r['sig']=='LOAI'],  key=lambda x:-x[1]['score'])

CRIT_LBL=['CumD','P>MA20','MA20>100','ClsPos','VolR','Slope','!DN']
W=76

pr('='*W)
pr(f'  SCAN {datetime.date.today()}  |  BUY:{len(buy)}  WATCH:{len(watch)}  AVOID:{len(avoid)}  LOAI:{len(loai)}')
pr('='*W)

def hdr():
    pr(f'  {"MA":<6} {"GIA":>9} {"CHG":>6} {"SCORE":>6} {"CRIT":>8} {"WAVE":<20} {"SUP":>9} {"VR":>4} {"SLP":>5}')
    pr('  '+'-'*72)

def row(t,r):
    w=r['wave']
    cs=''.join(['Y' if c else '.' for c in r['crit']])
    sup=f'{w.get("sup",0):,.0f}' if w.get('sup') else '---'
    pr(f'  {t:<6} {r["price"]:>9,.0f} {r["chg"]:>+5.1f}% {r["score"]:>5.0f}%  [{cs}]  {w["label"]:<20} {sup:>9} {r["vol_r"]:>3.1f}x {r["slope"]:>+4.1f}%')

if buy:
    pr(f'\n>>> BUY SIGNALS ({len(buy)} ma)'); hdr()
    for t,r in buy: row(t,r)
    pr('')
    for t,r in buy:
        w=r['wave']
        sup=f'{w.get("sup",0):,.0f}' if w.get('sup') else '---'
        res_=f'{w.get("res",0):,.0f}' if w.get('res') else '---'
        miss=[CRIT_LBL[i] for i,c in enumerate(r['crit']) if not c]
        pr(f'  {t}: {w["label"]} | Sup:{sup} Res:{res_} | Miss:[{" ".join(miss) if miss else "none"}]')

if watch:
    pr(f'\n>>> WATCH ({len(watch)} ma)'); hdr()
    for t,r in watch: row(t,r)
    pr('')
    for t,r in watch:
        w=r['wave']
        miss=[CRIT_LBL[i] for i,c in enumerate(r['crit']) if not c]
        sup=f'{w.get("sup",0):,.0f}' if w.get('sup') else '---'
        res_=f'{w.get("res",0):,.0f}' if w.get('res') else '---'
        pr(f'  {t}: {w["label"]} | Sup:{sup} Res:{res_} | Miss:[{" ".join(miss)}]')

if avoid:
    pr(f'\n>>> AVOID ({len(avoid)} ma)')
    pr('  '+', '.join([f'{t}({r["score"]:.0f}%)' for t,r in avoid]))

if loai:
    pr(f'\n>>> LOAI NGAY ({len(loai)} ma)')
    for t,r in loai:
        pr(f'  {t}: {r["rej_r"]} | {r["wave"]["label"]}')

pr('')
pr('  Criteria: [CumD][P>MA20][MA20>100][ClsPos>=50][VolR>=0.8][Slope>0.3][!DT]')
pr('='*W)

