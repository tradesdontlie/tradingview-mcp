const CDP=require('chrome-remote-interface');
const SYMS=['NASDAQ:QQQ','AMEX:IWM','AMEX:SPY','TVC:VIX','NASDAQ:NVDA','NASDAQ:MU','NYSE:TSM','NASDAQ:TSLA','NASDAQ:COIN','BLACKBULL:WTI'];
const run=(c,e)=>c.Runtime.evaluate({expression:e,returnByValue:true,awaitPromise:true}).then(r=>r&&r.result?r.result.value:null);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const _arg=process.argv[2];let _Y,_M,_D;if(_arg&&/^\d{4}-\d{2}-\d{2}$/.test(_arg)){[_Y,_M,_D]=_arg.split('-').map(Number);}else{const _et=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));_Y=_et.getFullYear();_M=_et.getMonth()+1;_D=_et.getDate();}
const day0=Date.UTC(_Y,_M-1,_D)/1000;
const preOpen=day0+8*3600, pmClose=day0+24*3600; // full extended day 4:00-20:00 ET
(async()=>{
 const c=await CDP({port:9222});await c.Runtime.enable();const out={};
 for(const sym of SYMS){
  try{
   await run(c,`window.TradingViewApi.activeChart().setSymbol(${JSON.stringify(sym)})`);await sleep(2200);
   await run(c,`window.TradingViewApi.activeChart().setResolution('5')`);await sleep(1700);
   const bars=await run(c,`(function(){try{var s=window.TradingViewApi.activeChart()._chartWidget.model().mainSeries();var b=s.bars();var d=[];b.each(function(t,bar){d.push([bar[0],bar[1],bar[2],bar[3],bar[4],bar[5]])});return d.slice(-900)}catch(e){return null}})()`);
   if(bars)out[sym.split(':')[1]]=bars.filter(x=>x[0]>=preOpen&&x[0]<pmClose);
   process.stderr.write(sym+' '+((out[sym.split(':')[1]]||[]).length)+' bars\n');
  }catch(e){process.stderr.write(sym+' ERR\n');}
 }
 console.log(JSON.stringify(out));await c.close();
})();
