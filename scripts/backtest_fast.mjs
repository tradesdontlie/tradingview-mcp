import CDP from 'chrome-remote-interface';
import fs from 'fs';

// Get the correct target (TradingView chart page)
const targets = await CDP.List({ host: 'localhost', port: 9222 });
const tvTarget = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
if (!tvTarget) { console.error('TradingView chart not found!', targets.map(t=>t.url)); process.exit(1); }
console.error('Using target:', tvTarget.title?.slice(0,50), tvTarget.id);

const client = await CDP({ host: 'localhost', port: 9222, target: tvTarget.id });
const { Runtime, Input, Page } = client;
await Runtime.enable();
await Page.enable();
const ev  = e => Runtime.evaluate({ expression: e, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MONACO = `(function(){
  var c=document.querySelector('.monaco-editor.pine-editor-monaco');if(!c)return null;
  var el=c,fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));if(fk)break;el=el.parentElement;}
  if(!fk)return null;var cur=el[fk];
  for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==='function'){var eds=env.editor.getEditors();if(eds.length>0)return{editor:eds[0],env};}}cur=cur.return;}return null;
})()`;

async function getStudies() {
  return ev(`(function(){try{return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s=>({id:s.id,name:s.name}));}catch(e){return[];}})()`);
}

async function getStats(label) {
  await sleep(3000);
  const r = await ev(`(function(){
    try{
      var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources=chart.model().model().dataSources();
      for(var i=0;i<sources.length;i++){
        var s=sources[i];var meta=null;
        try{if(s.metaInfo)meta=s.metaInfo();}catch(e){}
        var name=meta?(meta.description||meta.shortDescription||''):'';
        if(!name.toLowerCase().includes('orb'))continue;
        var rd=s._reportData;if(rd&&typeof rd.value==='function')rd=rd.value();
        if(!rd)return{error:'no rd'};
        function flat(p){if(!p)return{};var r={};Object.keys(p).forEach(function(k){var v=p[k];if(v!==null&&v!==undefined&&typeof v!=='function'&&typeof v!=='object')r[k]=Math.round(v*100)/100;});return r;}
        var pa=flat(rd.performance&&rd.performance.all);
        var pf=pa.grossProfit&&pa.grossLoss?Math.round(pa.grossProfit/Math.abs(pa.grossLoss)*100)/100:0;
        return{name,trades:pa.totalTrades||0,net:pa.netProfit||0,netPct:pa.netProfitPercent||0,gp:pa.grossProfit||0,gl:pa.grossLoss||0,pf,wr:pa.numberOfWiningTrades&&pa.totalTrades?Math.round(pa.numberOfWiningTrades/pa.totalTrades*100):0,wins:pa.numberOfWiningTrades||0,losses:pa.numberOfLosingTrades||0,maxDD:rd.performance?rd.performance.maxStrategyDrawDown:0};
      }
      return{error:'not found'};
    }catch(e){return{error:e.message};}
  })()`);
  console.error(`[${label}] trades=${r.trades} PF=${r.pf} WR=${r.wr}% net=$${r.net} DD=$${r.maxDD}`);
  return r;
}

async function inject(src) {
  // Open editor
  await ev(`(function(){var bwb=window.TradingView&&window.TradingView.bottomWidgetBar;if(bwb){if(typeof bwb.activateScriptEditorTab==='function')bwb.activateScriptEditorTab();else if(typeof bwb.showWidget==='function')bwb.showWidget('pine-editor');}var btn=document.querySelector('[data-name="pine-dialog-button"]');if(btn)btn.click();})()`);
  for(let i=0;i<30;i++){await sleep(100);if(await ev(`(function(){return ${MONACO}!==null;})()`))break;}
  // Remove old ORB strategy
  await ev(`(function(){try{var ch=window.TradingViewApi._activeChartWidgetWV.value();ch.getAllStudies().forEach(function(s){if((s.name||'').toLowerCase().includes('orb'))ch.removeEntity(s.id);});}catch(e){}})()`);
  await sleep(500);
  // Inject
  await ev(`(function(){var m=${MONACO};if(m){m.editor.setValue(${JSON.stringify(src)});m.editor.focus();}var ta=document.querySelector('.monaco-editor.pine-editor-monaco textarea');if(ta){ta.click();ta.focus();}})()`);
  await sleep(300);
  await Input.dispatchKeyEvent({type:'keyDown',modifiers:4,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleep(80);
  await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleep(1500);
  const hasNo=await ev(`Array.from(document.querySelectorAll('button')).some(b=>b.offsetParent&&(b.textContent||'').trim()==='No')`);
  if(hasNo){await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.offsetParent&&(b.textContent||'').trim()==='No').click()`);await sleep(1000);}
  const studies = await getStudies();
  return studies.some(s => s.name.toLowerCase().includes('orb'));
}

// ─── 1. Set 15m ──────────────────────────────────────────
await ev(`(function(){var c=window.TradingViewApi._activeChartWidgetWV.value();c.setSymbol('MNQ1!',{});c.setResolution('15',{});})()`);
await sleep(2000);
const initBars = await ev(`(function(){try{var b=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars();return b.size();}catch(e){return 0;}})()`);
console.error('Initial bars:', initBars, '| symbol:', await ev(`window.TradingViewApi._activeChartWidgetWV.value().symbol()`));

// ─── 2. Load strategy ────────────────────────────────────
const baseSrc = fs.readFileSync('/Users/kamilkoz56/tradingview-mcp/scripts/mnq_orb_strategy.pine','utf8');
const loaded = await inject(baseSrc);
console.error('Strategy loaded:', loaded);

// ─── 3. Scroll back to load history ──────────────────────
const cc = await ev(`(function(){var el=document.querySelector('.chart-container,[class*="chart-container"]')||document.body;var r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width*0.35),y:Math.round(r.top+r.height*0.5)};})()`);

let bars=0;
for(let b=0;b<8;b++){
  for(let i=0;i<20;i++){await Input.dispatchMouseEvent({type:'mouseWheel',x:cc.x,y:cc.y,deltaX:-600,deltaY:0});await sleep(30);}
  await sleep(2000);
  bars=await ev(`(function(){try{return window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars().size();}catch(e){return 0;}})()`);
  console.error(`Scroll ${b+1}: ${bars} bars`);
  if(bars>=4000)break;
}
console.error('History:', bars, 'bars loaded');

// ─── 4. Run param iterations ─────────────────────────────
const configs = [
  {sl:1.0,tp1:2.0,tp2:4.0,fast:9, slow:21,trend:50,  label:'A: 1×SL 2×TP1 4×TP2'},
  {sl:1.5,tp1:2.5,tp2:5.0,fast:9, slow:21,trend:50,  label:'B: 1.5×SL 2.5×TP1 5×TP2'},
  {sl:1.0,tp1:1.5,tp2:3.0,fast:8, slow:20,trend:34,  label:'C: tight fast EMAs'},
  {sl:2.0,tp1:3.0,tp2:6.0,fast:9, slow:21,trend:50,  label:'D: wide SL/TP'},
  {sl:1.0,tp1:2.0,tp2:4.0,fast:5, slow:13,trend:34,  label:'E: aggressive EMAs'},
  {sl:1.5,tp1:3.0,tp2:6.0,fast:9, slow:21,trend:100, label:'F: strong trend filter'},
];

function makeSrc(p) {
  return baseSrc
    .replace(/ema_fast\s*=\s*input\.int\(\d+/,  `ema_fast  = input.int(${p.fast}`)
    .replace(/ema_slow\s*=\s*input\.int\(\d+/,  `ema_slow  = input.int(${p.slow}`)
    .replace(/ema_trend\s*=\s*input\.int\(\d+/, `ema_trend = input.int(${p.trend}`)
    .replace(/sl_atr\s*=\s*input\.float\([\d.]+/, `sl_atr    = input.float(${p.sl}`)
    .replace(/tp1_atr\s*=\s*input\.float\([\d.]+/, `tp1_atr   = input.float(${p.tp1}`)
    .replace(/tp2_atr\s*=\s*input\.float\([\d.]+/, `tp2_atr   = input.float(${p.tp2}`);
}

let best = { trades: 0, pf: 0, wr: 0 };
let bestCfg = configs[0];
const results = [];

for(const cfg of configs) {
  const src = makeSrc(cfg);
  await inject(src);
  const s = await getStats(cfg.label);
  results.push({ ...cfg, ...s });
  if(s.trades > 5 && s.pf > best.pf) { best = s; bestCfg = cfg; console.error('  ★ New best!'); }
}

// ─── 5. Print summary ─────────────────────────────────────
console.log('\n=== BACKTEST RESULTS — MNQ 15m ORB + EMA Trend ===');
console.log('History loaded:', bars, 'bars (~', Math.round(bars/26), 'trading days)');
console.log('\nAll configs:');
results.forEach(r => {
  const marker = r.label === bestCfg.label ? ' ★ BEST' : '';
  console.log(`${r.label}${marker}`);
  console.log(`  Trades: ${r.trades}  |  Net P&L: $${r.net}  |  Win Rate: ${r.wr}%  |  Profit Factor: ${r.pf}  |  Max DD: $${r.maxDD}`);
});
console.log('\nBest config:', bestCfg.label);
console.log(JSON.stringify(best, null, 2));

const {data} = await Page.captureScreenshot({format:'jpeg',quality:65});
fs.writeFileSync('/tmp/tv_backtest_results.jpg', Buffer.from(data,'base64'));
console.error('Screenshot saved');

await client.close();
