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

const MONACO = `(function(){var c=document.querySelector('.monaco-editor.pine-editor-monaco');if(!c)return null;var el=c,fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));if(fk)break;el=el.parentElement;}if(!fk)return null;var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==='function'){var eds=env.editor.getEditors();if(eds.length>0)return{editor:eds[0],env};}}cur=cur.return;}return null;})()`;

const baseSrc = fs.readFileSync('/Users/kamilkoz56/tradingview-mcp/scripts/mnq_orb_strategy.pine','utf8');

function makeSrc(p) {
  return baseSrc
    .replace(/ema_fast\s*=\s*input\.int\(\d+/,  `ema_fast  = input.int(${p.fast}`)
    .replace(/ema_slow\s*=\s*input\.int\(\d+/,  `ema_slow  = input.int(${p.slow}`)
    .replace(/ema_trend\s*=\s*input\.int\(\d+/, `ema_trend = input.int(${p.trend}`)
    .replace(/sl_atr\s*=\s*input\.float\([\d.]+/, `sl_atr    = input.float(${p.sl}`)
    .replace(/tp1_atr\s*=\s*input\.float\([\d.]+/, `tp1_atr   = input.float(${p.tp1}`)
    .replace(/tp2_atr\s*=\s*input\.float\([\d.]+/, `tp2_atr   = input.float(${p.tp2}`);
}

async function inject(src) {
  await ev(`(function(){try{var ch=window.TradingViewApi._activeChartWidgetWV.value();ch.getAllStudies().forEach(function(s){if((s.name||'').toLowerCase().includes('orb')||(s.name||'').toLowerCase().includes('mnq orb'))ch.removeEntity(s.id);});}catch(e){}})()`);
  await sleep(400);
  for(let i=0;i<30;i++){await sleep(100);if(await ev(`(function(){return ${MONACO}!==null;})()`))break;}
  await ev(`(function(){var m=${MONACO};if(m){m.editor.setValue(${JSON.stringify(src)});m.editor.focus();}var ta=document.querySelector('.monaco-editor.pine-editor-monaco textarea');if(ta){ta.click();ta.focus();}})()`);
  await sleep(300);
  await Input.dispatchKeyEvent({type:'keyDown',modifiers:4,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleep(80);
  await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleep(1500);
  const hasDlg=await ev(`Array.from(document.querySelectorAll('button')).some(b=>b.offsetParent&&(b.textContent||'').trim()==='No')`);
  if(hasDlg){await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.offsetParent&&(b.textContent||'').trim()==='No').click()`);await sleep(800);}
}

async function getStats() {
  await sleep(3500);
  return ev(`(function(){
    try{
      var chart=window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var sources=chart.model().model().dataSources();
      for(var i=0;i<sources.length;i++){
        var s=sources[i];
        var rd=null;try{rd=s._reportData;if(rd&&typeof rd.value==='function')rd=rd.value();}catch(e){}
        if(!rd||!rd.performance)continue;
        function flat(p){if(!p)return{};var r={};Object.keys(p).forEach(function(k){var v=p[k];if(v!==null&&v!==undefined&&typeof v!=='function'&&typeof v!=='object')r[k]=Math.round(v*100)/100;});return r;}
        var pa=flat(rd.performance.all);
        var pf=pa.grossProfit&&pa.grossLoss?Math.round(pa.grossProfit/Math.abs(pa.grossLoss)*100)/100:0;
        return{trades:pa.totalTrades||0,net:pa.netProfit||0,pf,wr:pa.numberOfWiningTrades&&pa.totalTrades?Math.round(pa.numberOfWiningTrades/pa.totalTrades*100):0,maxDD:rd.performance.maxStrategyDrawDown||0,gp:pa.grossProfit||0,gl:Math.abs(pa.grossLoss||0)};
      }
      return null;
    }catch(e){return null;}
  })()`);
}

// Parameter sets to test
const configs = [
  {fast:9, slow:21, trend:50,  sl:1.0, tp1:2.0, tp2:4.0, label:'A'},
  {fast:9, slow:21, trend:50,  sl:1.5, tp1:2.5, tp2:5.0, label:'B'},
  {fast:9, slow:21, trend:50,  sl:1.0, tp1:1.5, tp2:3.5, label:'C: tight TP1'},
  {fast:8, slow:20, trend:34,  sl:1.0, tp1:2.0, tp2:4.0, label:'D: faster EMAs'},
  {fast:5, slow:13, trend:34,  sl:1.0, tp1:2.0, tp2:4.0, label:'E: aggressive EMAs'},
  {fast:9, slow:21, trend:100, sl:1.5, tp1:2.5, tp2:5.0, label:'F: strong trend'},
  {fast:9, slow:21, trend:50,  sl:2.0, tp1:3.0, tp2:6.0, label:'G: wide range'},
  {fast:9, slow:21, trend:50,  sl:0.75,tp1:2.0, tp2:4.0, label:'H: tiny SL'},
];

const results = [];
let best = { trades: 0, pf: 0 };
let bestCfg = configs[0];

for(const cfg of configs) {
  await inject(makeSrc(cfg));
  const s = await getStats();
  if(!s){results.push({...cfg,trades:0,net:0,pf:0,wr:0,maxDD:0});console.error(`[${cfg.label}] ERROR`);continue;}
  results.push({...cfg,...s});
  console.error(`[${cfg.label}] trades=${s.trades} PF=${s.pf} WR=${s.wr}% net=$${s.net} DD=$${s.maxDD}`);
  if(s.trades >= 30 && s.pf > best.pf){best=s;bestCfg=cfg;console.error('  ★ New best!');}
}

// Load best
await inject(makeSrc(bestCfg));
await sleep(3000);

console.log('\n=== MNQ 15m ORB + EMA Trend — Backtest Results ===');
console.log('Commission: $0/contract | Slippage: 0 | Margin: 0');
console.log(`History: ~${Math.round(5051/26)} trading days on 15m chart\n`);

results.sort((a,b) => b.pf - a.pf).forEach(r => {
  const star = r.label === bestCfg.label ? ' ★' : '';
  console.log(`Config ${r.label}${star}: EMA(${r.fast}/${r.slow}/${r.trend}) SL=${r.sl}× TP=${r.tp1}/${r.tp2}×`);
  console.log(`  Trades: ${r.trades}  Net: $${r.net}  PF: ${r.pf}  WR: ${r.wr}%  MaxDD: $${r.maxDD}`);
});

console.log(`\n★ BEST → Config ${bestCfg.label}`);
console.log(`  EMA ${bestCfg.fast}/${bestCfg.slow}/${bestCfg.trend} | SL ${bestCfg.sl}× ATR | TP1 ${bestCfg.tp1}× | TP2 ${bestCfg.tp2}×`);
console.log(`  Trades: ${best.trades} | Net P&L: $${best.net} | PF: ${best.pf} | WR: ${best.wr}% | MaxDD: $${best.maxDD}`);

const {data}=await Page.captureScreenshot({format:'jpeg',quality:70});
fs.writeFileSync('/tmp/tv_optimized.jpg',Buffer.from(data,'base64'));
console.error('\nScreenshot saved');

await client.close();
