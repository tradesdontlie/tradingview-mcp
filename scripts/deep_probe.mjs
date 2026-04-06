import CDP from 'chrome-remote-interface';
import fs from 'fs';

const targets = await CDP.List({ host: 'localhost', port: 9222 });
const tvTarget = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
const client = await CDP({ host: 'localhost', port: 9222, target: tvTarget.id });
const { Runtime, Page } = client;
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

// Check Monaco for compilation errors
await sleep(1000);
const errors = await ev(`(function(){
  var m=${MONACO};if(!m)return{error:'no monaco'};
  try{
    var model=m.editor.getModel();
    if(!model)return{error:'no model'};
    var markers=m.env.editor.getModelMarkers({resource:model.uri});
    return{errors:markers.filter(mk=>mk.severity>=8).map(mk=>({line:mk.startLineNumber,msg:mk.message})),
           warnings:markers.filter(mk=>mk.severity<8).length};
  }catch(e){return{error:e.message};}
})()`);
console.error('Compile errors:', JSON.stringify(errors));

// Deep probe the "My script" source
const probe = await ev(`(function(){
  try{
    var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var sources=chart.model().model().dataSources();
    // Find My script
    for(var i=0;i<sources.length;i++){
      var s=sources[i];
      var meta=null;try{if(s.metaInfo)meta=s.metaInfo();}catch(e){}
      var name=meta?(meta.description||meta.shortDescription||''):'';
      if(name!=='My script')continue;

      // Get all keys including prototype
      var allKeys=[];
      var obj=s;
      while(obj&&obj!==Object.prototype){
        Object.getOwnPropertyNames(obj).forEach(function(k){if(!allKeys.includes(k))allKeys.push(k);});
        obj=Object.getPrototypeOf(obj);
      }
      var stratKeys=allKeys.filter(k=>/report|order|trade|perf|equity|stat|backtest|result/i.test(k)).slice(0,30);

      // Try reportData on prototype
      var protoRD=null;
      try{
        var proto=Object.getPrototypeOf(s);
        if(proto&&typeof proto.reportData==='function'){
          protoRD=proto.reportData.call(s);
          if(protoRD&&typeof protoRD.value==='function')protoRD=protoRD.value();
        }
      }catch(e){protoRD='err:'+e.message;}

      // Try s.performance()
      var perfDirect=null;
      try{
        var p=s.performance;if(typeof p==='function')p=p.call(s);
        if(p&&typeof p.value==='function')p=p.value();
        perfDirect=p?typeof p:'null';
      }catch(e){perfDirect='err:'+e.message;}

      // Check compile/active status
      var status=null;
      try{var st=s._compileActiveStatus;status=st?JSON.stringify(st).slice(0,100):'none';}catch(e){}

      return{name,stratKeys:stratKeys.slice(0,20),protoRD:typeof protoRD==='object'?Object.keys(protoRD||{}).slice(0,10):protoRD,perfDirect,status,metaIsStrat:meta&&meta.is_price_study};
    }
    return{error:'My script not found'};
  }catch(e){return{error:e.message};}
})()`);
console.error('Deep probe:', JSON.stringify(probe, null, 2));

// Also check for Strategy Tester panel in DOM
const stratPanel = await ev(`(function(){
  var els=Array.from(document.querySelectorAll('[class*="strategy"],[data-name*="strategy"],[class*="backtest"]'));
  return els.slice(0,10).map(e=>({tag:e.tagName,cn:(e.className||'').slice(0,60),dn:e.getAttribute('data-name'),text:(e.textContent||'').trim().slice(0,50)}));
})()`);
console.error('Strategy panel elements:', JSON.stringify(stratPanel));

const {data}=await Page.captureScreenshot({format:'jpeg',quality:65});
fs.writeFileSync('/tmp/tv_probe.jpg',Buffer.from(data,'base64'));
await client.close();
