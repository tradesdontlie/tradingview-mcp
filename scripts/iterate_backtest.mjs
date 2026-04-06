import CDP from 'chrome-remote-interface';
import fs from 'fs';

const client = await CDP({ host: 'localhost', port: 9222 });
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

async function compileAndLoad(src) {
  // Open pine editor
  await ev(`(function(){var bwb=window.TradingView&&window.TradingView.bottomWidgetBar;if(bwb){if(typeof bwb.activateScriptEditorTab==='function')bwb.activateScriptEditorTab();else if(typeof bwb.showWidget==='function')bwb.showWidget('pine-editor');}var btn=document.querySelector('[data-name="pine-dialog-button"]');if(btn)btn.click();})()`);
  for(let i=0;i<40;i++){await sleep(150);if(await ev(`(function(){return ${MONACO}!==null;})()`))break;}

  // Remove existing strategy first
  await ev(`(function(){
    try{var chart=window.TradingViewApi._activeChartWidgetWV.value();
    var studies=chart.getAllStudies();
    studies.forEach(function(s){if((s.name||'').toLowerCase().includes('orb')||(s.name||'').toLowerCase().includes('koz algo'))chart.removeEntity(s.id);});}catch(e){}
  })()`);
  await sleep(1000);

  // Inject source
  await ev(`(function(){var m=${MONACO};if(m){m.editor.setValue(${JSON.stringify(src)});m.editor.focus();}var ta=document.querySelector('.monaco-editor.pine-editor-monaco textarea');if(ta){ta.click();ta.focus();}})()`);
  await sleep(400);

  // Cmd+Enter
  await Input.dispatchKeyEvent({type:'keyDown',modifiers:4,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleep(80);
  await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleep(2000);

  // Dismiss dialog
  const hasNo = await ev(`Array.from(document.querySelectorAll('button')).some(b=>b.offsetParent&&(b.textContent||'').trim()==='No')`);
  if(hasNo){await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.offsetParent&&(b.textContent||'').trim()==='No').click()`);await sleep(1500);}

  const studies = await ev(`(function(){try{return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s=>s.name);}catch(e){return [];}})()`);
  return studies;
}

async function getStats() {
  await sleep(5000);
  return ev(`(function(){
    try{
      var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources=chart.model().model().dataSources();
      for(var i=0;i<sources.length;i++){
        var s=sources[i];var meta=null;
        try{if(s.metaInfo)meta=s.metaInfo();}catch(e){}
        var name=meta?(meta.description||meta.shortDescription||''):'';
        if(!name.toLowerCase().includes('orb')&&!name.toLowerCase().includes('koz algo'))continue;
        var rd=s._reportData;
        if(rd&&typeof rd.value==='function')rd=rd.value();
        if(!rd)return{error:'no rd',name};
        function flat(p){if(!p)return{};var r={};Object.keys(p).forEach(function(k){var v=p[k];if(v!==null&&v!==undefined&&typeof v!=='function'&&typeof v!=='object')r[k]=Math.round(v*100)/100;});return r;}
        var pa=flat(rd.performance&&rd.performance.all);
        var pf=pa.grossProfit&&pa.grossLoss?Math.round((pa.grossProfit/Math.abs(pa.grossLoss))*100)/100:0;
        return{
          name,
          trades:rd.trades?rd.trades.length:0,
          netPnl:pa.netProfit||0,
          netPct:pa.netProfitPercent||0,
          grossProfit:pa.grossProfit||0,
          grossLoss:pa.grossLoss||0,
          profitFactor:pf,
          winRate:pa.numberOfWiningTrades&&pa.totalTrades?Math.round(pa.numberOfWiningTrades/pa.totalTrades*100):0,
          wins:pa.numberOfWiningTrades||0,
          losses:pa.numberOfLosingTrades||0,
          maxDD:rd.performance?rd.performance.maxStrategyDrawDown:0,
          avgBarsInTrade:pa.avgBarsInTrade||0
        };
      }
      return{error:'not found'};
    }catch(e){return{error:e.message};}
  })()`);
}

// ─── STEP 1: Switch to 15m ────────────────────────────────
await ev(`(function(){var c=window.TradingViewApi._activeChartWidgetWV.value();c.setSymbol('MNQ1!',{});c.setResolution('15',{});})()`);
await sleep(3000);
console.error('15m chart set');

// ─── STEP 2: Load base strategy ──────────────────────────
const baseSrc = fs.readFileSync('/Users/kamilkoz56/tradingview-mcp/scripts/mnq_orb_strategy.pine','utf8');
const studies = await compileAndLoad(baseSrc);
console.error('Loaded:', studies);

// ─── STEP 3: Load history ─────────────────────────────────
const cc = await ev(`(function(){var el=document.querySelector('.chart-container,[class*="chart-container"]')||document.body;var r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width*0.35),y:Math.round(r.top+r.height*0.5)};})()`);
let bars = await ev(`window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars().size()||0`);
console.error('Initial bars:', bars);

for(let b=0;b<10;b++){
  for(let i=0;i<20;i++){await Input.dispatchMouseEvent({type:'mouseWheel',x:cc.x,y:cc.y,deltaX:-600,deltaY:0});await sleep(40);}
  await sleep(2500);
  bars = await ev(`window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars().size()||0`);
  console.error(`Scroll batch ${b+1}: ${bars} bars`);
  if(bars>=5000)break;
}
console.error('History loaded:', bars, 'bars');

// ─── STEP 4: Get initial results ─────────────────────────
let stats = await getStats();
console.error('Base stats:', JSON.stringify(stats));

// ─── STEP 5: Iterate params for better results ───────────
const paramSets = [
  {sl:1.0, tp1:1.5, tp2:3.0, fast:9,  slow:21, trend:50},  // tight SL wide TP
  {sl:1.5, tp1:2.0, tp2:4.0, fast:9,  slow:21, trend:50},  // default
  {sl:1.0, tp1:2.0, tp2:3.5, fast:8,  slow:20, trend:50},  // slightly faster
  {sl:2.0, tp1:3.0, tp2:5.0, fast:9,  slow:21, trend:50},  // wide SL/TP
  {sl:1.0, tp1:2.5, tp2:5.0, fast:5,  slow:13, trend:34},  // faster signals
  {sl:1.5, tp1:3.0, tp2:6.0, fast:9,  slow:21, trend:100}, // strong trend filter
];

let best = stats;
let bestParams = paramSets[1];

function makeSrc(p) {
  return fs.readFileSync('/Users/kamilkoz56/tradingview-mcp/scripts/mnq_orb_strategy.pine','utf8')
    .replace(/ema_fast\s*=\s*input\.int\(\d+/,  `ema_fast  = input.int(${p.fast}`)
    .replace(/ema_slow\s*=\s*input\.int\(\d+/,  `ema_slow  = input.int(${p.slow}`)
    .replace(/ema_trend\s*=\s*input\.int\(\d+/, `ema_trend = input.int(${p.trend}`)
    .replace(/sl_atr\s*=\s*input\.float\([\d.]+/, `sl_atr    = input.float(${p.sl}`)
    .replace(/tp1_atr\s*=\s*input\.float\([\d.]+/, `tp1_atr   = input.float(${p.tp1}`)
    .replace(/tp2_atr\s*=\s*input\.float\([\d.]+/, `tp2_atr   = input.float(${p.tp2}`);
}

for(const [idx, params] of paramSets.entries()) {
  console.error(`\nTesting param set ${idx+1}:`, params);
  const src = makeSrc(params);
  await compileAndLoad(src);
  // wait for history to still be loaded
  await sleep(2000);
  const s = await getStats();
  console.error(`  trades=${s.trades} PF=${s.profitFactor} win=${s.winRate}% net=$${s.netPnl} DD=$${s.maxDD}`);
  if(s.trades > (best.trades||0) && s.profitFactor > (best.profitFactor||0)) {
    best = s;
    bestParams = params;
    console.error('  *** New best!');
  }
}

// ─── STEP 6: Load best params ────────────────────────────
console.error('\nBest params:', bestParams);
const finalSrc = makeSrc(bestParams);
await compileAndLoad(finalSrc);
await sleep(3000);
const final = await getStats();

console.log('\n=== FINAL BACKTEST RESULTS — MNQ 15m ORB Strategy ===');
console.log(JSON.stringify(final, null, 2));
console.log('\nBest params:', JSON.stringify(bestParams, null, 2));

const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 65 });
fs.writeFileSync('/tmp/tv_final_backtest.jpg', Buffer.from(data, 'base64'));
console.error('Screenshot saved');

await client.close();
