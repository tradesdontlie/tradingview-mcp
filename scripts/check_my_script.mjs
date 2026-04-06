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

// Check all data sources and find strategy
const sources = await ev(`(function(){
  try{
    var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources=chart.model().model().dataSources();
    var info=[];
    for(var i=0;i<sources.length;i++){
      var s=sources[i];
      var meta=null;try{if(s.metaInfo)meta=s.metaInfo();}catch(e){}
      var name=meta?(meta.description||meta.shortDescription||meta.id||''):'';
      var hasRD=!!(s._reportData);
      var hasOD=!!(s.ordersData);
      var rdSize=0;
      try{
        var rd=s._reportData;if(rd&&typeof rd.value==='function')rd=rd.value();
        if(rd&&rd.trades)rdSize=rd.trades.length||0;
      }catch(e){}
      info.push({i,name,hasRD,hasOD,rdSize,isStrat:meta&&meta.is_price_study!==undefined});
    }
    return info;
  }catch(e){return{error:e.message};}
})()`);
console.error('All sources:', JSON.stringify(sources, null, 2));

// Try to get stats from any source with reportData
const stats = await ev(`(function(){
  try{
    var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources=chart.model().model().dataSources();
    for(var i=0;i<sources.length;i++){
      var s=sources[i];
      if(!s._reportData)continue;
      var rd=s._reportData;if(rd&&typeof rd.value==='function')rd=rd.value();
      if(!rd||!rd.performance)continue;
      var meta=null;try{if(s.metaInfo)meta=s.metaInfo();}catch(e){}
      var name=meta?(meta.description||meta.shortDescription||''):'source_'+i;
      function flat(p){if(!p)return{};var r={};Object.keys(p).forEach(function(k){var v=p[k];if(v!==null&&v!==undefined&&typeof v!=='function'&&typeof v!=='object')r[k]=Math.round(v*100)/100;});return r;}
      var pa=flat(rd.performance&&rd.performance.all);
      return{
        name,
        trades:rd.trades?rd.trades.length:0,
        net:pa.netProfit||0,
        pf:pa.grossProfit&&pa.grossLoss?Math.round(pa.grossProfit/Math.abs(pa.grossLoss)*100)/100:0,
        wr:pa.numberOfWiningTrades&&pa.totalTrades?Math.round(pa.numberOfWiningTrades/pa.totalTrades*100):0,
        wins:pa.numberOfWiningTrades||0,losses:pa.numberOfLosingTrades||0,
        maxDD:rd.performance?rd.performance.maxStrategyDrawDown:0,
        gp:pa.grossProfit||0, gl:pa.grossLoss||0
      };
    }
    return{error:'no strategy with data'};
  }catch(e){return{error:e.message};}
})()`);
console.error('Stats:', JSON.stringify(stats));

// Also try to open the Pine editor using keyboard shortcut
await ev(`(function(){
  // Try Alt+P or other shortcuts to open Pine editor
  var btn=document.querySelector('[data-name="pine-dialog-button"]');
  if(btn){btn.click();return 'clicked pine-dialog-button';}
  // Try finding any Pine-related buttons
  var allBtns=Array.from(document.querySelectorAll('button,[role="button"]'));
  var pineBtn=allBtns.find(b=>(b.getAttribute('aria-label')||'').toLowerCase().includes('pine'));
  if(pineBtn){pineBtn.click();return 'clicked pine aria-label';}
  return 'no pine button found';
})()`);
await sleep(2000);

// Check if Pine editor opened
const monacoReady = await ev(`(function(){
  var c=document.querySelector('.monaco-editor.pine-editor-monaco');return !!c;
})()`);
console.error('Monaco element visible:', monacoReady);

// Screenshot
const {data} = await Page.captureScreenshot({format:'jpeg',quality:60});
fs.writeFileSync('/tmp/tv_check.jpg', Buffer.from(data,'base64'));
console.error('Screenshot saved');

await client.close();
