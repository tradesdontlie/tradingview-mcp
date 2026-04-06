import CDP from 'chrome-remote-interface';
import fs from 'fs';

const targets = await CDP.List({ host: 'localhost', port: 9222 });
const tvTarget = targets.find(t => t.url && t.url.includes('tradingview.com/chart'));
if (!tvTarget) { console.error('No TradingView chart target found'); process.exit(1); }
const client = await CDP({ host: 'localhost', port: 9222, target: tvTarget.id });
const { Runtime, Input, Page } = client;
await Runtime.enable();
await Page.enable();
const ev = e => Runtime.evaluate({ expression: e, awaitPromise: false, returnByValue: true }).then(r => r.result.value);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MONACO = `(function(){var c=document.querySelector('.monaco-editor.pine-editor-monaco');if(!c)return null;var el=c,fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(k=>k.startsWith('__reactFiber$'));if(fk)break;el=el.parentElement;}if(!fk)return null;var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==='function'){var eds=env.editor.getEditors();if(eds.length>0)return{editor:eds[0],env};}}cur=cur.return;}return null;})()`;

// ── Step 1: Switch to XAUUSD 15m ──────────────────────────
console.error('Switching to XAUUSD 15m...');
await ev(`(function(){
  try {
    var w = window.TradingViewApi._activeChartWidgetWV.value();
    w.setSymbol('OANDA:XAUUSD');
  } catch(e) { return 'err:'+e.message; }
})()`);
await sleep(3000);

await ev(`(function(){
  try {
    var w = window.TradingViewApi._activeChartWidgetWV.value();
    w.setResolution('15');
  } catch(e) { return 'err:'+e.message; }
})()`);
await sleep(2000);

// Verify
const chartInfo = await ev(`(function(){
  try {
    var w = window.TradingViewApi._activeChartWidgetWV.value();
    return { symbol: w.symbol(), tf: w.resolution() };
  } catch(e) { return {error: e.message}; }
})()`);
console.error('Chart:', JSON.stringify(chartInfo));

// ── Step 2: Load history via scroll ───────────────────────
console.error('Loading history...');
for (let batch = 0; batch < 8; batch++) {
  for (let i = 0; i < 20; i++) {
    await Input.dispatchMouseEvent({ type: 'mouseWheel', x: 600, y: 400, deltaX: -600, deltaY: 0 });
    await sleep(50);
  }
  await sleep(1500);
}

const barCount = await ev(`(function(){
  try {
    var c = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var s = c.model().model().mainSeries();
    return s.data().bars().size();
  } catch(e) { return 'err:'+e.message; }
})()`);
console.error('Bars loaded:', barCount);

// ── Step 3: Clean old studies ─────────────────────────────
await ev(`(function(){
  try {
    var ch = window.TradingViewApi._activeChartWidgetWV.value();
    ch.getAllStudies().forEach(function(s){
      var n = (s.name||'').toLowerCase();
      if(n.includes('xauusd') || n.includes('london') || n.includes('breakout') || n.includes('koz') || n.includes('orb') || n.includes('mnq'))
        ch.removeEntity(s.id);
    });
  } catch(e){}
})()`);
await sleep(500);

// ── Step 4: Open Pine editor ──────────────────────────────
await ev(`(function(){var btn=document.querySelector('[data-name="pine-dialog-button"]')||document.querySelector('[aria-label="Pine"]');if(btn)btn.click();})()`);
let monacoReady = false;
for (let i = 0; i < 50; i++) {
  await sleep(150);
  monacoReady = await ev(`(function(){return ${MONACO}!==null;})()`);
  if (monacoReady) break;
}
console.error('Monaco ready:', monacoReady);

// ── Strategy source ───────────────────────────────────────
const baseSrc = fs.readFileSync('/Users/kamilkoz56/tradingview-mcp/scripts/xauusd_strategy.pine', 'utf8');

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
  await ev(`(function(){try{var ch=window.TradingViewApi._activeChartWidgetWV.value();ch.getAllStudies().forEach(function(s){var n=(s.name||'').toLowerCase();if(n.includes('xauusd')||n.includes('london')||n.includes('breakout')||n.includes('koz'))ch.removeEntity(s.id);});}catch(e){}})()`);
  await sleep(300);
  for(let i=0;i<30;i++){await sleep(100);if(await ev(`(function(){return ${MONACO}!==null;})()`))break;}
  await ev(`(function(){var m=${MONACO};if(m){m.editor.setValue(${JSON.stringify(src)});m.editor.focus();}var ta=document.querySelector('.monaco-editor.pine-editor-monaco textarea');if(ta){ta.click();ta.focus();}})()`);
  await sleep(200);
  await Input.dispatchKeyEvent({type:'keyDown',modifiers:4,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleep(60);
  await Input.dispatchKeyEvent({type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await sleep(1200);
  const hasDlg=await ev(`Array.from(document.querySelectorAll('button')).some(b=>b.offsetParent&&(b.textContent||'').trim()==='No')`);
  if(hasDlg){await ev(`Array.from(document.querySelectorAll('button')).find(b=>b.offsetParent&&(b.textContent||'').trim()==='No').click()`);await sleep(600);}
}

async function getStats() {
  await sleep(3000);
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

// ── Parameter sets to test ────────────────────────────────
const configs = [
  {fast:9,  slow:21, trend:50,  sl:1.5, tp1:2.5, tp2:5.0, label:'A: baseline'},
  {fast:9,  slow:21, trend:50,  sl:1.0, tp1:2.0, tp2:4.0, label:'B: tighter SL'},
  {fast:9,  slow:21, trend:50,  sl:2.0, tp1:3.0, tp2:6.0, label:'C: wide range'},
  {fast:9,  slow:21, trend:50,  sl:0.75,tp1:2.0, tp2:4.0, label:'D: tiny SL'},
  {fast:8,  slow:20, trend:34,  sl:1.5, tp1:2.5, tp2:5.0, label:'E: fast EMAs'},
  {fast:5,  slow:13, trend:34,  sl:1.5, tp1:2.5, tp2:5.0, label:'F: aggressive EMAs'},
  {fast:9,  slow:21, trend:100, sl:1.5, tp1:2.5, tp2:5.0, label:'G: strong trend'},
  {fast:12, slow:26, trend:50,  sl:1.5, tp1:2.0, tp2:4.5, label:'H: slower cross'},
  {fast:9,  slow:21, trend:50,  sl:1.0, tp1:1.5, tp2:3.0, label:'I: tight TPs'},
  {fast:9,  slow:21, trend:50,  sl:1.5, tp1:3.0, tp2:7.0, label:'J: wide TPs'},
];

const results = [];
let best = { trades: 0, pf: 0 };
let bestCfg = configs[0];

for (const cfg of configs) {
  await inject(makeSrc(cfg));
  const s = await getStats();
  if (!s) { results.push({...cfg,trades:0,net:0,pf:0,wr:0,maxDD:0}); console.error(`[${cfg.label}] ERROR`); continue; }
  results.push({...cfg,...s});
  console.error(`[${cfg.label}] trades=${s.trades} PF=${s.pf} WR=${s.wr}% net=$${s.net} DD=$${s.maxDD}`);
  if (s.trades >= 20 && s.pf > best.pf) { best=s; bestCfg=cfg; console.error('  ★ New best!'); }
}

// Load best config
await inject(makeSrc(bestCfg));
await sleep(2000);

console.log('\n=== XAUUSD 15m London/NY Breakout — Backtest Results ===');
console.log('Commission: $0 | Slippage: 0 | Margin: 0');
console.log(`Bars: ~${barCount}\n`);

results.sort((a,b) => b.pf - a.pf).forEach(r => {
  const star = r.label === bestCfg.label ? ' ★' : '';
  console.log(`Config ${r.label}${star}: EMA(${r.fast}/${r.slow}/${r.trend}) SL=${r.sl}× TP=${r.tp1}/${r.tp2}×`);
  console.log(`  Trades: ${r.trades}  Net: $${r.net}  PF: ${r.pf}  WR: ${r.wr}%  MaxDD: $${r.maxDD}`);
});

console.log(`\n★ BEST → Config ${bestCfg.label}`);
console.log(`  EMA ${bestCfg.fast}/${bestCfg.slow}/${bestCfg.trend} | SL ${bestCfg.sl}× ATR | TP1 ${bestCfg.tp1}× | TP2 ${bestCfg.tp2}×`);
console.log(`  Trades: ${best.trades} | Net P&L: $${best.net} | PF: ${best.pf} | WR: ${best.wr}% | MaxDD: $${best.maxDD}`);

const {data} = await Page.captureScreenshot({format:'jpeg',quality:70});
fs.writeFileSync('/tmp/tv_gold_optimized.jpg', Buffer.from(data,'base64'));
console.error('\nScreenshot saved to /tmp/tv_gold_optimized.jpg');

await client.close();
