import CDP from 'chrome-remote-interface';
import fs from 'fs';

const targets = await CDP.List({ host: 'localhost', port: 9222 });
const tvTarget = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
const client = await CDP({ host: 'localhost', port: 9222, target: tvTarget.id });
const { Runtime, Input, Page } = client;
await Runtime.enable();
await Page.enable();
const ev = e => Runtime.evaluate({ expression: e, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MONACO = `(function(){
  var c=document.querySelector('.monaco-editor.pine-editor-monaco');if(!c)return null;
  var el=c,fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));if(fk)break;el=el.parentElement;}
  if(!fk)return null;var cur=el[fk];
  for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==='function'){var eds=env.editor.getEditors();if(eds.length>0)return{editor:eds[0],env};}}cur=cur.return;}return null;
})()`;

// Remove ALL user-added strategies from chart
await ev(`(function(){
  try{
    var ch=window.TradingViewApi._activeChartWidgetWV.value();
    var keep=['key opens','All-In-One Sessions','ICT HTF Candles'];
    ch.getAllStudies().forEach(function(s){
      var n=s.name||'';
      if(!keep.some(function(k){return n.includes(k)})) ch.removeEntity(s.id);
    });
  }catch(e){}
})()`);
await sleep(1000);
console.error('Cleared old studies');

// Open Pine Editor and wait for Monaco
await ev(`(function(){var btn=document.querySelector('[data-name="pine-dialog-button"]')||document.querySelector('[aria-label="Pine"]');if(btn)btn.click();})()`);
let monacoReady=false;
for(let i=0;i<50;i++){
  await sleep(200);
  monacoReady=await ev(`(function(){return ${MONACO}!==null;})()`);
  if(monacoReady)break;
}
console.error('Monaco:', monacoReady);

// Read strategy source
const src = fs.readFileSync('/Users/kamilkoz56/tradingview-mcp/scripts/mnq_orb_strategy.pine','utf8');
console.error('Source lines:', src.split('\n').length);
console.error('Has strategy():', src.includes('strategy('));

// Inject source
await ev(`(function(){
  var m=${MONACO};
  if(!m){console.error('no monaco');return;}
  m.editor.setValue(${JSON.stringify(src)});
  m.editor.focus();
  var ta=document.querySelector('.monaco-editor.pine-editor-monaco textarea');
  if(ta){ta.click();ta.focus();}
})()`);
await sleep(500);

// Compile
await Input.dispatchKeyEvent({type:'keyDown',modifiers:4,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
await sleep(100);
await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
await sleep(2500);

// Handle save dialog
const hasDlg=await ev(`Array.from(document.querySelectorAll('button')).some(b=>b.offsetParent&&(b.textContent||'').trim()==='No')`);
if(hasDlg){await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.offsetParent&&(b.textContent||'').trim()==='No').click()`);await sleep(1200);}

// Check studies
const studies=await ev(`(function(){try{return window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(s=>s.name);}catch(e){return[];}})()`);
console.error('Studies:', studies);

// Wait for compute and get stats
await sleep(5000);

const perf=await ev(`(function(){
  try{
    var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources=chart.model().model().dataSources();
    var best=null;
    for(var i=0;i<sources.length;i++){
      var s=sources[i];
      // Check ALL sources for _reportData
      var rd=null;
      try{rd=s._reportData;if(rd&&typeof rd.value==='function')rd=rd.value();}catch(e){}
      if(!rd||!rd.performance)continue;
      var meta=null;try{if(s.metaInfo)meta=s.metaInfo();}catch(e){}
      var name=meta?(meta.description||meta.shortDescription||'source_'+i):'source_'+i;
      function flat(p){if(!p)return{};var r={};Object.keys(p).forEach(function(k){var v=p[k];if(v!==null&&v!==undefined&&typeof v!=='function'&&typeof v!=='object')r[k]=Math.round(v*100)/100;});return r;}
      var pa=flat(rd.performance.all);
      var pf=pa.grossProfit&&pa.grossLoss?Math.round(pa.grossProfit/Math.abs(pa.grossLoss)*100)/100:0;
      var trades=[];
      if(Array.isArray(rd.trades)){
        trades=rd.trades.slice(-10).map(function(t){
          if(!t||typeof t!=='object')return null;
          var tr={};Object.keys(t).forEach(function(k){var v=t[k];if(v!==null&&v!==undefined&&typeof v!=='function'&&typeof v!=='object')tr[k]=v;});return tr;
        }).filter(Boolean);
      }
      best={name,trades:pa.totalTrades||0,net:pa.netProfit||0,netPct:pa.netProfitPercent||0,pf,
            wr:pa.numberOfWiningTrades&&pa.totalTrades?Math.round(pa.numberOfWiningTrades/pa.totalTrades*100):0,
            wins:pa.numberOfWiningTrades||0,losses:pa.numberOfLosingTrades||0,
            maxDD:rd.performance.maxStrategyDrawDown||0,gp:pa.grossProfit||0,gl:pa.grossLoss||0,
            avgBars:pa.avgBarsInTrade||0,recentTrades:trades};
    }
    return best||{error:'no strategy data found'};
  }catch(e){return{error:e.message};}
})()`);
console.log(JSON.stringify(perf,null,2));

const {data}=await Page.captureScreenshot({format:'jpeg',quality:65});
fs.writeFileSync('/tmp/tv_fresh.jpg',Buffer.from(data,'base64'));
await client.close();
