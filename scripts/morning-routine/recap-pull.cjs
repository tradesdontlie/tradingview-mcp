#!/usr/bin/env node
// Evening recap: pull today's RTH + post-market data for the watchlist via CDP.
const CDP = require('chrome-remote-interface');

const SYMS = [
  'AMEX:SPY','NASDAQ:QQQ','AMEX:IWM','TVC:VIX','BLACKBULL:WTI',
  'NASDAQ:RKLB','NASDAQ:HOOD','NASDAQ:INTC','NASDAQ:NVDA','NASDAQ:AMZN','NASDAQ:AAPL','NASDAQ:GOOGL',
  'NASDAQ:CRWV','NASDAQ:MRNA','NYSE:TSM','NYSE:IONQ','NYSE:TWLO','NYSE:NOW','NASDAQ:TSLA','NASDAQ:SPCX',
  'NYSE:UNH','NYSE:LLY','NASDAQ:CRDO','NASDAQ:NTAP','NASDAQ:GH','NASDAQ:NBIS','NASDAQ:ADBE','NASDAQ:CRWD',
  'NYSE:ORCL','NASDAQ:IREN','NYSE:RDW','NYSE:BE','NASDAQ:ASTS','NASDAQ:AVGO','NASDAQ:MRVL','NASDAQ:PLTR',
  'NYSE:CRCL','NYSE:DOCN','NASDAQ:SMCI','NASDAQ:APLD','NYSE:JPM','NASDAQ:AFRM','NASDAQ:MSFT','AMEX:UMAC',
  'CBOE:SNXX','CME_MINI:ES1!','CME_MINI:NQ1!','NASDAQ:AMD','NASDAQ:BIDU','NASDAQ:CIFR','NASDAQ:CLSK',
  'NASDAQ:COIN','NASDAQ:FLY','NASDAQ:MCHP','NASDAQ:META','NASDAQ:MU','NASDAQ:OUST','NASDAQ:QCOM',
  'NASDAQ:RGTI','NASDAQ:SNDK','NASDAQ:UAL','NASDAQ:VSAT','NASDAQ:WDC','NASDAQ:WULF','NYSE:CRM',
  'NYSE:DELL','NYSE:HPE','NYSE:MP','NYSE:NIO','NYSE:OKLO','NYSE:PL','TVC:RUT','TVC:SPX','BATS:BTDR'
];

// TARGET date from argv (YYYY-MM-DD); falls back to current ET date. No daily file-edit needed.
const _arg = process.argv[2];
let Y, M, D;
if (_arg && /^\d{4}-\d{2}-\d{2}$/.test(_arg)) {
  [Y, M, D] = _arg.split('-').map(Number);
} else {
  const _et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  Y = _et.getFullYear(); M = _et.getMonth() + 1; D = _et.getDate();
}
// session windows in UTC seconds (assumes US Eastern DST; summer)
const day0 = Date.UTC(Y,M-1,D)/1000;           // 00:00 UTC of the target day
const rthOpen  = day0 + 13*3600 + 30*60;       // 13:30 UTC = 9:30 ET
const rthClose = day0 + 20*3600;               // 20:00 UTC = 16:00 ET
const pmClose  = day0 + 24*3600;               // 24:00 UTC = 20:00 ET
const preOpen  = day0 + 8*3600;                // 08:00 UTC = 4:00 ET

const run = (c,e)=>c.Runtime.evaluate({expression:e,returnByValue:true,awaitPromise:true}).then(r=>r&&r.result?r.result.value:null);
const sleep = ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  const client = await CDP({port:9222});
  await client.Runtime.enable();
  const out=[];
  for(const sym of SYMS){
    try{
      await run(client,`window.TradingViewApi.activeChart().setSymbol(${JSON.stringify(sym)})`);
      await sleep(2200);
      await run(client,`window.TradingViewApi.activeChart().setResolution('5')`);
      await sleep(1600);
      const bars = await run(client,`(function(){try{var s=window.TradingViewApi.activeChart()._chartWidget.model().mainSeries();var b=s.bars();var d=[];b.each(function(t,bar){d.push([bar[0],bar[1],bar[2],bar[3],bar[4],bar[5]])});return d.slice(-1200)}catch(e){return null}})()`);
      if(!bars||!bars.length){out.push({sym,err:'nobars'});continue;}
      // bars: [time(sec),o,h,l,c,v]
      const rth = bars.filter(x=>x[0]>=rthOpen && x[0]<rthClose);
      const pm  = bars.filter(x=>x[0]>=rthClose && x[0]<pmClose);
      const pre = bars.filter(x=>x[0]>=preOpen && x[0]<rthOpen);
      let r=null;
      if(rth.length){
        const hi=Math.max(...rth.map(x=>x[2])), lo=Math.min(...rth.map(x=>x[3]));
        r={open:rth[0][1],high:hi,low:lo,close:rth[rth.length-1][4],
           hiT:rth.find(x=>x[2]===hi)[0],loT:rth.find(x=>x[3]===lo)[0],bars:rth.length};
      }
      let p=null;
      if(pm.length){ p={last:pm[pm.length-1][4],high:Math.max(...pm.map(x=>x[2])),low:Math.min(...pm.map(x=>x[3]))}; }
      let pr=null;
      if(pre.length){ pr={high:Math.max(...pre.map(x=>x[2])),low:Math.min(...pre.map(x=>x[3]))}; }
      out.push({sym,rth:r,pm:p,pre:pr});
      process.stderr.write(`${sym} rth=${r?r.close:'-'} pm=${p?p.last:'-'}\n`);
    }catch(e){ out.push({sym,err:String(e).slice(0,80)}); }
  }
  console.log(JSON.stringify(out));
  await client.close();
})();
