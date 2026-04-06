import CDP from 'chrome-remote-interface';
import fs from 'fs';

const targets = await CDP.List({ host: 'localhost', port: 9222 });
const tvTarget = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
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

// Check state
const state = await ev(`(function(){
  try{
    var ch=window.TradingViewApi._activeChartWidgetWV.value();
    var bars=ch._chartWidget.model().mainSeries().bars();
    return{symbol:ch.symbol(),res:ch.resolution(),bars:bars.size(),studies:ch.getAllStudies().map(s=>s.name)};
  }catch(e){return{error:e.message};}
})()`);
console.error('State:', JSON.stringify(state));

// Remove any existing ORB strategy
await ev(`(function(){try{var ch=window.TradingViewApi._activeChartWidgetWV.value();ch.getAllStudies().forEach(function(s){if((s.name||'').toLowerCase().includes('orb'))ch.removeEntity(s.id);});}catch(e){}})()`);
await sleep(500);

// Open Pine editor — try multiple ways
await ev(`(function(){
  // Method 1: bottomWidgetBar
  var bwb=window.TradingView&&window.TradingView.bottomWidgetBar;
  if(bwb){
    if(typeof bwb.activateScriptEditorTab==='function'){bwb.activateScriptEditorTab();return;}
    if(typeof bwb.showWidget==='function'){bwb.showWidget('pine-editor');return;}
  }
  // Method 2: button click
  var btn=document.querySelector('[data-name="pine-dialog-button"]')||document.querySelector('[aria-label="Pine"]');
  if(btn)btn.click();
})()`);
await sleep(1000);

// Wait for Monaco
let monacoReady = false;
for(let i=0;i<50;i++){
  await sleep(150);
  monacoReady = await ev(`(function(){return ${MONACO}!==null;})()`);
  if(monacoReady)break;
}
console.error('Monaco ready:', monacoReady);

if(!monacoReady) {
  const ss = await Page.captureScreenshot({format:'jpeg',quality:50});
  fs.writeFileSync('/tmp/tv_no_monaco.jpg', Buffer.from(ss.data,'base64'));
  console.error('Monaco not found, screenshot saved');
  await client.close();
  process.exit(1);
}

// Inject strategy
const src = fs.readFileSync('/Users/kamilkoz56/tradingview-mcp/scripts/mnq_orb_strategy.pine','utf8');
await ev(`(function(){
  var m=${MONACO};
  if(m){m.editor.setValue(${JSON.stringify(src)});m.editor.focus();}
  var ta=document.querySelector('.monaco-editor.pine-editor-monaco textarea');
  if(ta){ta.click();ta.focus();}
})()`);
await sleep(400);

// Cmd+Enter
await Input.dispatchKeyEvent({type:'keyDown',modifiers:4,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
await sleep(80);
await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
await sleep(2000);

// Handle dialog
const hasDlg = await ev(`Array.from(document.querySelectorAll('button')).some(b=>b.offsetParent&&(b.textContent||'').trim()==='No')`);
if(hasDlg){
  await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.offsetParent&&(b.textContent||'').trim()==='No').click()`);
  await sleep(1000);
}

// Verify loaded
const studies = await ev(`(function(){try{return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s=>s.name);}catch(e){return [];}})()`);
console.error('Studies after inject:', studies);

await sleep(5000); // let strategy compute

// Read stats
const perf = await ev(`(function(){
  try{
    var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources=chart.model().model().dataSources();
    for(var i=0;i<sources.length;i++){
      var s=sources[i];var meta=null;
      try{if(s.metaInfo)meta=s.metaInfo();}catch(e){}
      var name=meta?(meta.description||meta.shortDescription||''):'';
      if(!name.toLowerCase().includes('orb'))continue;
      var rd=s._reportData;if(rd&&typeof rd.value==='function')rd=rd.value();
      if(!rd)return{error:'no rd',name};
      function flat(p){if(!p)return{};var r={};Object.keys(p).forEach(function(k){var v=p[k];if(v!==null&&v!==undefined&&typeof v!=='function'&&typeof v!=='object')r[k]=Math.round(v*100)/100;});return r;}
      var pa=flat(rd.performance&&rd.performance.all);
      var pf=pa.grossProfit&&pa.grossLoss?Math.round(pa.grossProfit/Math.abs(pa.grossLoss)*100)/100:0;

      // Get trades
      var trades=[];
      if(Array.isArray(rd.trades)){
        trades=rd.trades.slice(-10).map(function(t){
          if(!t||typeof t!=='object')return null;
          var tr={};Object.keys(t).forEach(function(k){var v=t[k];if(v!==null&&v!==undefined&&typeof v!=='function'&&typeof v!=='object')tr[k]=v;});return tr;
        }).filter(Boolean);
      }

      return{
        name,bars:${state.bars||0},
        trades:pa.totalTrades||0,net:pa.netProfit||0,netPct:pa.netProfitPercent||0,
        grossProfit:pa.grossProfit||0,grossLoss:pa.grossLoss||0,
        pf,wr:pa.numberOfWiningTrades&&pa.totalTrades?Math.round(pa.numberOfWiningTrades/pa.totalTrades*100):0,
        wins:pa.numberOfWiningTrades||0,losses:pa.numberOfLosingTrades||0,
        maxDD:rd.performance?rd.performance.maxStrategyDrawDown:0,
        avgBars:pa.avgBarsInTrade||0,
        recentTrades:trades
      };
    }
    return{error:'ORB strategy not in data sources'};
  }catch(e){return{error:e.message};}
})()`);
console.log(JSON.stringify(perf,null,2));

const {data} = await Page.captureScreenshot({format:'jpeg',quality:65});
fs.writeFileSync('/tmp/tv_run_backtest.jpg', Buffer.from(data,'base64'));
await client.close();
