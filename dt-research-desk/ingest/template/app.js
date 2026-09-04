const D = window.__DATA__;
const $  = (s,r)=> (r||document).querySelector(s);
const $$ = (s,r)=> Array.from((r||document).querySelectorAll(s));
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const DATES = Object.keys(D.sp1500).sort();
const md = d => { const [y,m,dd]=d.split('-'); return dd.replace(/^0/,'')+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m-1]; };
const CSS = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ---------- tabs ---------- */
$$('.nav button').forEach(b=>b.addEventListener('click',()=>{
  $$('.nav button').forEach(x=>x.setAttribute('aria-selected', x===b));
  $$('main > section').forEach(s=>s.classList.add('hide'));
  $('#v-'+b.dataset.v).classList.remove('hide');
  window.scrollTo({top:0,behavior:'smooth'});
  if(b.dataset.v==='charts') drawAll();
}));

/* ---------- position derivation ---------- */
function book(){
  const by={};
  D.trades.slice().sort((a,b)=>a.date<b.date?-1:1).forEach(t=>{
    (by[t.ticker] = by[t.ticker] || []).push(t);
  });
  const open=[], closed=[];
  Object.entries(by).forEach(([tk,evts])=>{
    const last=evts[evts.length-1], first=evts[0];
    const rec={ticker:tk,name:last.name,sector:last.sector,theme:last.theme,asset:last.asset,
      opened:first.date,last:last.date,n:evts.length,evts};
    if(last.action==='SELL'){
      rec.closed=last.date; rec.why=last.why||last.rationale;
      const buy=evts.find(e=>e.action==='BUY'||e.action==='ADD');
      rec.held = buy ? Math.round((new Date(last.date)-new Date(buy.date))/864e5) : null;
      closed.push(rec);
    } else {
      let sz=null; for(let i=evts.length-1;i>=0;i--) if(evts[i].size!=null){sz=evts[i].size;break;}
      rec.size=sz; rec.why=last.rationale; open.push(rec);
    }
  });
  open.sort((a,b)=>(b.size||0)-(a.size||0));
  closed.sort((a,b)=>a.closed<b.closed?1:-1);
  return {open,closed};
}
const BOOK = book();
$('#kpiOpen').textContent = BOOK.open.length;

/* ---------- masthead KPIs (computed, never hand-typed) ---------- */
(function(){
  const P=D.perf[D.perf.length-1];
  const ex=P.dt-P.spx;
  $('#kExcess').textContent=(ex>=0?'+':'')+ex.toFixed(1);
  $('#kExcess').className='v '+(ex>=0?'up':'dn');
  $('#kExcessD').textContent='pp, '+md(P.date);
  const cashPts=D.perf.filter(p=>p.cash!=null);
  const lastCash=cashPts[cashPts.length-1], firstCash=cashPts[0];
  $('#kCash').textContent=lastCash?lastCash.cash+'%':'n/d';
  $('#kCashD').textContent=firstCash&&lastCash&&firstCash!==lastCash
    ? 'from '+firstCash.cash+'% on '+md(firstCash.date) : 'last disclosed';
  const b0=100*D.sp1500[DATES[0]].universe.BB/D.sp1500[DATES[0]].n;
  const bN=100*D.sp1500[DATES[DATES.length-1]].universe.BB/D.sp1500[DATES[DATES.length-1]].n;
  $('#kBreadth').textContent=bN.toFixed(1)+'%';
  $('#kBreadth').className='v '+(bN>=b0?'up':'dn');
  $('#kBreadthD').textContent='dual-bull, '+(bN-b0>=0?'+':'')+(bN-b0).toFixed(1)+'pp';
  $('#kActions').textContent=D.trades.length;
  const ds=D.trades.map(t=>t.date).sort();
  $('#kActionsD').textContent=md(ds[0])+' – '+md(ds[ds.length-1]);
  const cov=$('#kCoverage');
  if(cov) cov.textContent=D.meta.n_pdf+' source PDFs and '+D.meta.n_xlsx+
    ' ranking workbooks. '+md(ds[0])+' – '+md(D.meta.asof)+' '+D.meta.asof.slice(0,4)+'.';
})();

/* ---------- unified records ---------- */
const RECS = [
  ...D.trades.map(t=>({kind:'trade',date:t.date,subject:t.ticker,name:t.name,action:t.action,size:t.size,
      sector:t.sector,theme:t.theme,asset:t.asset,direction:t.direction,conviction:t.conviction,
      text:t.rationale,url:t.url,pdf:t.pdf,src:t.source==='slack'?'#dt_trade_updates':'Weekly Brief PDF'})),
  ...D.calls.map(c=>({kind:'call',date:c.date,subject:c.subject,name:c.category,action:'CALL',size:null,
      sector:null,theme:c.category,asset:c.category,direction:c.direction,conviction:c.conviction,
      text:c.thesis+' — '+c.evidence,url:c.url,pdf:c.pdf,src:'#mo-publishing',status:c.status}))
].sort((a,b)=>a.date<b.date?1:-1);

const closedT = new Set(BOOK.closed.map(c=>c.ticker));
RECS.forEach(r=>{
  if(r.kind==='trade') r.state = closedT.has(r.subject) ? 'closed':'open';
  else r.state = /reversed|faded|closed/.test(r.status||'') ? 'closed':'open';
});

/* ---------- filter UI ---------- */
function opts(sel,label,vals){
  const el=$(sel); el.innerHTML = `<option value="">${label}</option>` +
    vals.filter(Boolean).map(v=>`<option>${esc(v)}</option>`).join('');
}
opts('#fsector','All sectors',[...new Set(D.trades.map(t=>t.sector))].sort());
opts('#fasset','All types',[...new Set(RECS.map(r=>r.asset))].sort());
opts('#fdir','All directions',[...new Set(RECS.map(r=>r.direction))].sort());
opts('#fconv','All conviction',['high','med','low']);
opts('#fsrc','All sources',[...new Set(RECS.map(r=>r.src))].sort());

// default the date filter to the full span of the data — a hardcoded end date
// silently hides every record added after the build that baked it in
const ALLD = RECS.map(r=>r.date).sort();
const DMIN = ALLD[0], DMAX = ALLD[ALLD.length-1];
$('#fd1').value = DMIN; $('#fd2').value = DMAX;

let STATE='';
$$('#fstate button').forEach(b=>b.addEventListener('click',()=>{
  $$('#fstate button').forEach(x=>x.setAttribute('aria-pressed',x===b)); STATE=b.dataset.s; render();
}));
['#fq','#fkind','#fsector','#fasset','#fdir','#fconv','#fsrc','#fd1','#fd2']
  .forEach(s=>$(s).addEventListener('input',render));
$('#freset').addEventListener('click',()=>{
  ['#fq','#fkind','#fsector','#fasset','#fdir','#fconv','#fsrc'].forEach(s=>$(s).value='');
  $('#fd1').value=DMIN; $('#fd2').value=DMAX;
  STATE=''; $$('#fstate button').forEach((x,i)=>x.setAttribute('aria-pressed', i===0)); render();
});

const convChip = c => c==='high'?'<span class="chip acc">High</span>'
  : c==='low'?'<span class="chip plain">Low</span>':'<span class="chip plain">Med</span>';
const dirChip = d => /bull|long/.test(d)?`<span class="chip bull">${esc(d)}</span>`
  : /bear|exit|short/.test(d)?`<span class="chip bear">${esc(d)}</span>`:`<span class="chip neu">${esc(d)}</span>`;
const actChip = a => a==='BUY'?'<span class="chip bull">Buy</span>'
  : a==='ADD'?'<span class="chip bull">Add</span>'
  : a==='SELL'?'<span class="chip bear">Sell</span>'
  : a==='TRIM'?'<span class="chip bear">Trim</span>':'<span class="chip acc">Call</span>';

function render(){
  const q=$('#fq').value.toLowerCase().trim(), k=$('#fkind').value, sc=$('#fsector').value,
        as=$('#fasset').value, dr=$('#fdir').value, cv=$('#fconv').value, sr=$('#fsrc').value,
        d1=$('#fd1').value, d2=$('#fd2').value;
  const rows = RECS.filter(r=>
    (!k || r.kind===k) && (!sc || r.sector===sc) && (!as || r.asset===as) &&
    (!dr || r.direction===dr) && (!cv || r.conviction===cv) && (!sr || r.src===sr) &&
    (!STATE || r.state===STATE) && (!d1 || r.date>=d1) && (!d2 || r.date<=d2) &&
    (!q || (r.subject+' '+r.name+' '+r.text+' '+(r.theme||'')+' '+(r.sector||'')).toLowerCase().includes(q))
  );
  $('#fcount').textContent = `${rows.length} of ${RECS.length} records`;
  $('#dbBody').innerHTML = rows.map(r=>`<tr>
    <td class="mono" style="white-space:nowrap;font-size:12px">${esc(r.date)}</td>
    <td>${r.kind==='trade'?'<span class="chip plain">Trade</span>':'<span class="chip plain">Research</span>'}</td>
    <td><span class="tick">${esc(r.subject)}</span>${r.kind==='trade'?`<div class="co">${esc(r.name)}</div>`:''}</td>
    <td>${actChip(r.action)} ${r.kind==='call'?dirChip(r.direction):''}</td>
    <td class="num mono">${r.size!=null?r.size.toFixed(2)+'%':'—'}</td>
    <td style="font-size:12.5px;color:var(--muted)">${esc(r.sector||'—')}</td>
    <td style="font-size:12.5px;color:var(--muted)">${esc(r.theme||'—')}</td>
    <td>${convChip(r.conviction)}</td>
    <td class="why">${esc(r.text)}</td>
    <td style="font-size:11.5px">${r.url?`<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.src)}</a>`:esc(r.src)}
      ${r.pdf?`<div class="co mono" style="font-size:10.5px;margin-top:2px">${esc(r.pdf)}</div>`:''}</td></tr>`).join('')
    || `<tr><td colspan="10" style="padding:26px;text-align:center;color:var(--muted)">No records match these filters.</td></tr>`;
}
render();

/* ---------- timeline ---------- */
const REGIME=D.regime;;
$('#tlList').innerHTML = REGIME.map(r=>`<div class="tl-item ${r.dir==='bull'?'bull':r.dir==='bear'?'bear':''}">
  <div class="tl-d">${esc(r.date)}</div><div class="tl-h">${esc(r.title)}</div><div class="tl-b">${esc(r.body)}</div></div>`).join('');

/* ---------- weekly 1500 ---------- */
const SECS = D.sp1500[DATES[0]].sectors.map(s=>s.Sector);
const rankOf=(d,s)=>{const m=D.sp1500[d].sectors.find(x=>x.Sector===s);return m?+m.Rank:null;};
const scoreOf=(d,s)=>{const m=D.sp1500[d].sectors.find(x=>x.Sector===s);return m?+m['Avg Score']:null;};
const REPORTS={'2026-07-17':'2026-07-20','2026-07-31':'2026-08-03','2026-08-07':'2026-08-10',
  '2026-08-14':'2026-08-17','2026-08-21':'2026-08-24','2026-08-28':'2026-08-31'};

$('#wkCards').innerHTML = DATES.map((d,i)=>{
  const prev = i? DATES[i-1]:null;
  const ranked = SECS.map(s=>({s,r:rankOf(d,s),sc:scoreOf(d,s),dr:prev?rankOf(prev,s)-rankOf(d,s):0}))
    .sort((a,b)=>a.r-b.r);
  const movers = prev ? ranked.slice().sort((a,b)=>Math.abs(b.dr)-Math.abs(a.dr)).filter(x=>x.dr!==0).slice(0,3):[];
  const bb = D.sp1500[d].universe, pct=(100*bb.BB/D.sp1500[d].n).toFixed(1);
  return `<div style="border:1px solid var(--line);border-radius:2px;padding:13px 15px;background:var(--surface-2)">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">
      <div><span class="lbl">Data ${esc(md(d))}</span>
        <div class="mono" style="font-size:12px;color:var(--muted)">report ${esc(md(REPORTS[d]||d))}</div></div>
      <div style="text-align:right"><span class="lbl">Dual-bull</span>
        <div class="mono" style="font-size:16px;font-weight:600">${pct}%</div></div>
    </div>
    <div style="margin-top:10px"><span class="lbl">Top 3</span>
      <div style="font-size:13.5px;margin-top:3px">${ranked.slice(0,3).map((x,j)=>
        `<span class="mono" style="color:var(--faint)">${j+1}</span> ${esc(x.s)}`).join(' &nbsp;·&nbsp; ')}</div></div>
    ${movers.length?`<div style="margin-top:9px"><span class="lbl">Biggest moves</span>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">${movers.map(m=>
        `<span class="chip ${m.dr>0?'bull':'bear'}">${esc(m.s)} ${m.dr>0?'+':''}${m.dr}</span>`).join('')}</div></div>`:''}
  </div>`;
}).join('');

function matrix(el, valfn, fmt, colorMode){
  const head = `<thead><tr><th style="min-width:180px">Sector</th>${DATES.map(d=>
    `<th class="num">${esc(md(d))}</th>`).join('')}<th class="num">Net</th></tr></thead>`;
  const ordered = SECS.slice().sort((a,b)=>rankOf(DATES[DATES.length-1],a)-rankOf(DATES[DATES.length-1],b));
  const body = ordered.map(s=>{
    const vals = DATES.map(d=>valfn(d,s));
    const net = colorMode==='rank' ? vals[0]-vals[vals.length-1] : vals[vals.length-1]-vals[0];
    return `<tr><td class="tick">${esc(s)}</td>${vals.map((v,i)=>{
      const prev = i? vals[i-1]:null;
      const delta = prev==null?0:(colorMode==='rank'? prev-v : v-prev);
      const c = delta>0?'var(--bull)':delta<0?'var(--bear)':'var(--ink-2)';
      return `<td class="num mono" style="color:${c}">${fmt(v)}</td>`;
    }).join('')}<td class="num mono" style="font-weight:600;color:${net>0?'var(--bull)':net<0?'var(--bear)':'var(--muted)'}">${net>0?'+':''}${colorMode==='rank'?net:net.toFixed(1)}</td></tr>`;
  }).join('');
  el.innerHTML = head+'<tbody>'+body+'</tbody>';
}
matrix($('#rankTable'),rankOf,v=>v,'rank');
matrix($('#scoreTable'),scoreOf,v=>v.toFixed(1),'score');

const PERSIST=D.persistence;;
$('#persistTable').innerHTML = `<thead><tr><th>Call date</th><th>Call</th><th>Conviction</th><th>Outcome</th><th>What happened</th></tr></thead><tbody>`+
 PERSIST.map(p=>`<tr><td class="mono" style="font-size:12px;white-space:nowrap">${p.date}</td>
  <td class="tick">${esc(p.call)}</td><td>${convChip(p.conviction)}</td>
  <td><span class="chip ${p.tone}">${esc(p.outcome)}</span></td><td class="why">${esc(p.note)}</td></tr>`).join('')+'</tbody>';

/* ---------- active book ---------- */
function bookTable(el, rows, closed){
  el.innerHTML = `<thead><tr><th>Ticker</th><th>Name</th><th>Type</th><th>Sector</th><th>Theme</th>
    ${closed?'<th class="num">Held</th><th>Closed</th>':'<th class="num">Weight</th><th>First in record</th>'}
    <th class="num">Actions</th><th>Latest note</th></tr></thead><tbody>`+
    rows.map(r=>`<tr><td class="tick">${esc(r.ticker)}</td><td style="font-size:13px">${esc(r.name)}</td>
    <td><span class="chip plain">${esc(r.asset)}</span></td>
    <td style="font-size:12.5px;color:var(--muted)">${esc(r.sector||'—')}</td>
    <td style="font-size:12.5px;color:var(--muted)">${esc(r.theme||'—')}</td>
    ${closed?`<td class="num mono">${r.held!=null?r.held+'d':'—'}</td><td class="mono" style="font-size:12px">${esc(r.closed)}</td>`
            :`<td class="num mono">${r.size!=null?r.size.toFixed(2)+'%':'n/d'}</td><td class="mono" style="font-size:12px">${esc(r.opened)}</td>`}
    <td class="num mono">${r.n}</td><td class="why">${esc(r.why||'')}</td></tr>`).join('')+'</tbody>';
}
bookTable($('#openTable'),BOOK.open,false);
bookTable($('#closedTable'),BOOK.closed,true);

/* ---------- workflow ---------- */
const C=D.copy.workflow;
$('#wf').innerHTML = `
<div class="grid2"><div>
<h3 style="font-size:13.5px;margin-bottom:9px">${esc(C.cycleTitle)}</h3>
<div class="tl">${C.cycle.map(x=>`<div class="tl-item"><div class="tl-d">${esc(x[0])}</div>
  <div class="tl-h">${esc(x[1])}</div><div class="tl-b">${x[2]}</div></div>`).join('')}</div>
</div><div>
<h3 style="font-size:13.5px;margin-bottom:9px">${esc(C.mechTitle)}</h3>
<dl class="kv">${C.mech.map(x=>`<dt>${esc(x[0])}</dt><dd>${x[1]}</dd>`).join('')}</dl>
<div class="callout" style="margin-top:14px">${C.callout}</div>
</div></div>`;

/* ---------- summary + footer + book note ---------- */
(function(){
  const S=D.copy.summary;
  $('#sumRange').textContent=D.copy.sumRange;
  $('#sumBody').innerHTML=`
    <div class="callout" style="margin-bottom:18px">${S.lede}</div>
    <div class="grid2">
      <div><h3 style="font-size:13.5px;margin-bottom:8px">${esc(S.driversTitle)}</h3>
        <ol style="margin:0;padding-left:20px;font-size:13.5px;color:var(--ink-2);display:flex;flex-direction:column;gap:9px">
        ${S.drivers.map(d=>`<li>${d}</li>`).join('')}</ol></div>
      <div><h3 style="font-size:13.5px;margin-bottom:8px">${esc(S.testsTitle)}</h3>
        <div style="display:flex;flex-direction:column;gap:11px;font-size:13.5px;color:var(--ink-2)">
        ${S.tests.map(t=>`<div><span class="chip ${t.tone} nodot">${esc(t.label)}</span>
          <p style="margin:5px 0 0">${t.body}</p></div>`).join('')}</div></div>
    </div>
    <div class="hr"></div>
    <h3 style="font-size:13.5px;margin-bottom:10px">${esc(S.methodTitle)}</h3>
    <div class="tscroll"><table><thead><tr><th>Component</th><th class="num">Weight</th><th>What it measures</th></tr></thead>
      <tbody>${S.method.map(m=>`<tr><td class="tick">${esc(m[0])}</td><td class="num mono">${esc(m[1])}</td>
        <td class="why">${m[2]}</td></tr>`).join('')}</tbody></table></div>
    <p style="font-size:12.5px;color:var(--muted);margin:10px 0 0">${S.methodNote}</p>`;
  $('#footBody').innerHTML=`<p style="margin:0 0 4px">${D.copy.footer.sources}</p>
    <p style="margin:0;color:var(--faint)">${D.copy.footer.rights}</p>`;
  const bn=$('#bookNote'); if(bn) bn.textContent=D.copy.bookNote;
  const bl=$('#brandline'); if(bl) bl.textContent=D.copy.brandline;
})();

/* ---------- charts ---------- */
const note = k => `<p style="font-size:12.5px;color:var(--muted);margin:10px 0 0">${D.copy.chartNotes[k]}</p>`;
let drawn=false;
function drawAll(){ if(drawn) return; drawn=true; bump(); breadth(); perf(); stack(); themes(); cadence(); }

const PAL=['#B4761A','#0E7C5A','#B4382C','#3D6E9E','#7A5EA8','#2F8A8A','#9E6B3D','#5C6B87','#8A7B2F','#A8457C','#4A7A3D'];
function svg(w,h){const s=document.createElementNS('http://www.w3.org/2000/svg','svg');
  s.setAttribute('viewBox',`0 0 ${w} ${h}`); s.setAttribute('width','100%'); s.setAttribute('role','img'); return s;}
function el(n,a,t){const e=document.createElementNS('http://www.w3.org/2000/svg',n);
  for(const k in a) e.setAttribute(k,a[k]); if(t!=null) e.textContent=t; return e;}

function bump(){
  const W=1180,H=440,L=168,R=158,T=26,B=34;
  const x=i=>L+i*(W-L-R)/(DATES.length-1), y=r=>T+(r-1)*(H-T-B)/10;
  const s=svg(W,H);
  for(let r=1;r<=11;r++){ s.appendChild(el('line',{x1:L,x2:W-R,y1:y(r),y2:y(r),class:'gridline'}));
    s.appendChild(el('text',{x:L-10,y:y(r)+3,'text-anchor':'end',class:'axis'},r)); }
  DATES.forEach((d,i)=>s.appendChild(el('text',{x:x(i),y:H-12,'text-anchor':'middle',class:'axis-b'},md(d))));
  const ordered=SECS.slice().sort((a,b)=>rankOf(DATES[DATES.length-1],a)-rankOf(DATES[DATES.length-1],b));
  ordered.forEach((sec,k)=>{
    const pts=DATES.map((d,i)=>[x(i),y(rankOf(d,sec))]);
    const g=el('g',{class:'bl','data-s':sec}); const col=PAL[k%PAL.length];
    g.appendChild(el('path',{d:'M'+pts.map(p=>p.join(' ')).join('L'),fill:'none',stroke:col,
      'stroke-width':2.2,'stroke-linejoin':'round','stroke-linecap':'round'}));
    pts.forEach(p=>g.appendChild(el('circle',{cx:p[0],cy:p[1],r:3.1,fill:col})));
    g.appendChild(el('text',{x:W-R+9,y:y(rankOf(DATES[DATES.length-1],sec))+3.5,class:'serieslbl',fill:col},sec));
    g.appendChild(el('text',{x:L-30,y:y(rankOf(DATES[0],sec))+3.5,'text-anchor':'end',class:'serieslbl',fill:col},
      sec.length>16?sec.slice(0,15)+'…':sec));
    g.style.transition='opacity .15s';
    g.addEventListener('mouseenter',()=>$$('.bl',s).forEach(o=>o.style.opacity = o===g?1:.13));
    g.addEventListener('mouseleave',()=>$$('.bl',s).forEach(o=>o.style.opacity=1));
    s.appendChild(g);
  });
  $('#cBump').appendChild(s);
}

function lineChart(host,series,fmt,dom){
  const W=560,H=250,L=52,R=18,T=18,B=34;
  const dates=series[0].pts.map(p=>p[0]);
  const all=series.flatMap(s=>s.pts.map(p=>p[1]));
  const lo=dom?dom[0]:Math.min(...all), hi=dom?dom[1]:Math.max(...all), pad=(hi-lo)*.14||1;
  const y=v=>T+(hi+pad-v)*(H-T-B)/((hi+pad)-(lo-pad));
  const x=i=>L+i*(W-L-R)/(dates.length-1);
  const s=svg(W,H);
  for(let i=0;i<=4;i++){const v=lo-pad+i*((hi+pad)-(lo-pad))/4;
    s.appendChild(el('line',{x1:L,x2:W-R,y1:y(v),y2:y(v),class:'gridline'}));
    s.appendChild(el('text',{x:L-8,y:y(v)+3,'text-anchor':'end',class:'axis'},fmt(v)));}
  dates.forEach((d,i)=>s.appendChild(el('text',{x:x(i),y:H-11,'text-anchor':'middle',class:'axis-b'},md(d))));
  series.forEach(ser=>{
    const pts=ser.pts.map((p,i)=>[x(i),y(p[1])]);
    if(ser.fill){ s.appendChild(el('path',{d:'M'+pts.map(p=>p.join(' ')).join('L')+`L${pts[pts.length-1][0]} ${H-B}L${pts[0][0]} ${H-B}Z`,
      fill:ser.color,opacity:.11})); }
    s.appendChild(el('path',{d:'M'+pts.map(p=>p.join(' ')).join('L'),fill:'none',stroke:ser.color,'stroke-width':2.3,'stroke-linejoin':'round'}));
    pts.forEach((p,i)=>s.appendChild(el('circle',{cx:p[0],cy:p[1],r:i===pts.length-1?4.2:2.9,fill:ser.color})));
    const last=pts[pts.length-1];
    s.appendChild(el('text',{x:last[0]-7,y:last[1]-15,'text-anchor':'end',class:'serieslbl',fill:ser.color},ser.label));
  });
  host.appendChild(s);
}
function breadth(){
  lineChart($('#cBreadth'),[{label:'Dual-bullish %',color:CSS('--accent'),fill:true,
    pts:DATES.map(d=>[d,100*D.sp1500[d].universe.BB/D.sp1500[d].n])}],v=>v.toFixed(0)+'%');
  $('#cBreadth').insertAdjacentHTML('beforeend',note('breadth'));
}
function perf(){
  lineChart($('#cPerf'),[
    {label:'Dual Trend',color:CSS('--accent'),pts:D.perf.map(p=>[p.date,p.dt])},
    {label:'S&P 500',color:CSS('--neutral'),pts:D.perf.map(p=>[p.date,p.spx])}],v=>v.toFixed(0)+'%');
  $('#cPerf').insertAdjacentHTML('beforeend',note('perf'));
}
function stack(){
  const d=DATES[DATES.length-1], secs=D.sp1500[d].sectors.slice().sort((a,b)=>+a.Rank-+b.Rank);
  const W=1180,H=52+secs.length*30,L=178,R=110,T=30;
  const s=svg(W,H); const bw=W-L-R;
  const keys=[['Bull/Bull',CSS('--bull')],['Bull/Bear','#3D6E9E'],['Bear/Bull',CSS('--accent')],['Bear/Bear',CSS('--bear')]];
  keys.forEach((k,i)=>{ s.appendChild(el('rect',{x:L+i*135,y:8,width:9,height:9,fill:k[1],rx:1}));
    s.appendChild(el('text',{x:L+i*135+14,y:16.5,class:'axis-b'},k[0])); });
  secs.forEach((sec,i)=>{
    const tot=keys.reduce((a,k)=>a+ +sec[k[0]],0)||1; let cx=L; const yy=T+i*30;
    s.appendChild(el('text',{x:L-10,y:yy+14,'text-anchor':'end',class:'serieslbl',fill:CSS('--ink-2')},sec.Sector));
    s.appendChild(el('text',{x:L-152,y:yy+14,class:'serieslbl',fill:CSS('--faint')},sec.Rank));
    keys.forEach(k=>{ const w=bw*(+sec[k[0]])/tot;
      s.appendChild(el('rect',{x:cx,y:yy+2,width:Math.max(w,0),height:19,fill:k[1],opacity:.86})); cx+=w; });
    s.appendChild(el('text',{x:W-R+9,y:yy+15,class:'serieslbl',fill:CSS('--muted')},
      Math.round(100*(+sec['Bull/Bull'])/tot)+'% dual-bull'));
  });
  $('#cStack').appendChild(s);
}
function barChart(host,rows,color){
  const max=Math.max(...rows.map(r=>r[1]))||1;
  host.innerHTML = `<div style="display:flex;flex-direction:column;gap:7px">`+rows.map(r=>
    `<div style="display:grid;grid-template-columns:150px 1fr 34px;gap:11px;align-items:center">
      <span style="font-size:12.5px;color:var(--ink-2);text-align:right">${esc(r[0])}</span>
      <span class="bar"><i style="width:${100*r[1]/max}%;background:${color}"></i></span>
      <span class="mono" style="font-size:12px;color:var(--muted)">${r[1]}</span></div>`).join('')+`</div>`;
}
function themes(){
  const c={}; D.trades.forEach(t=>{const k=t.theme||t.sector||'Other'; c[k]=(c[k]||0)+1;});
  barChart($('#cThemes'),Object.entries(c).sort((a,b)=>b[1]-a[1]),CSS('--accent'));
  $('#cThemes').insertAdjacentHTML('beforeend',note('themes'));
}
function cadence(){
  const wk={}; D.trades.forEach(t=>{
    const dt=new Date(t.date); const mon=new Date(dt); mon.setDate(dt.getDate()-((dt.getDay()+6)%7));
    const k=mon.toISOString().slice(0,10); wk[k]=wk[k]||{BUY:0,ADD:0,SELL:0,TRIM:0}; wk[k][t.action]++;});
  const ks=Object.keys(wk).sort();
  const W=560,H=250,L=44,R=16,T=20,B=36, bw=(W-L-R)/ks.length;
  const max=Math.max(...ks.map(k=>Object.values(wk[k]).reduce((a,b)=>a+b,0)))||1;
  const s=svg(W,H);
  for(let i=0;i<=max;i++){const yy=T+(max-i)*(H-T-B)/max;
    s.appendChild(el('line',{x1:L,x2:W-R,y1:yy,y2:yy,class:'gridline'}));
    s.appendChild(el('text',{x:L-8,y:yy+3,'text-anchor':'end',class:'axis'},i));}
  const cols=[['BUY',CSS('--bull')],['ADD','#3D6E9E'],['TRIM',CSS('--accent')],['SELL',CSS('--bear')]];
  ks.forEach((k,i)=>{ let acc=0;
    cols.forEach(c=>{ const v=wk[k][c[0]]; if(!v) return;
      const h=v*(H-T-B)/max; const yy=T+(H-T-B)-(acc+v)*(H-T-B)/max;
      s.appendChild(el('rect',{x:L+i*bw+bw*.19,y:yy,width:bw*.62,height:h,fill:c[1],opacity:.88,rx:1})); acc+=v; });
    s.appendChild(el('text',{x:L+i*bw+bw/2,y:H-12,'text-anchor':'middle',class:'axis-b'},md(k)));});
  cols.forEach((c,i)=>{ s.appendChild(el('rect',{x:L+i*88,y:2,width:8,height:8,fill:c[1],rx:1}));
    s.appendChild(el('text',{x:L+i*88+12,y:9.5,class:'axis-b'},c[0][0]+c[0].slice(1).toLowerCase()));});
  $('#cCadence').appendChild(s);
  $('#cCadence').insertAdjacentHTML('beforeend',note('cadence'));
}
