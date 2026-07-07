#!/usr/bin/env node
/**
 * Adjust HOOD/CRWV play lines to today's gap-reclaim structure, and probe whether
 * QQQ's live price is readable from the watchlist DOM (non-intrusive — no chart switch).
 */
const CDP = require('chrome-remote-interface');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = async (c, e) => { const r = await c.Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : null; };

const ENTRY = '#00E676', TARGET = '#E040FB';
const ADJ = [
  { sym: 'NASDAQ:HOOD', entry: 102.60, eLbl: 'ADJ ENTRY 102.60 (PMH reclaim)', target: 105.69, tLbl: 'ADJ TARGET 105.69 (gap fill)' },
  { sym: 'NASDAQ:CRWV', entry: 106.24, eLbl: 'ADJ ENTRY 106.24 (PMH reclaim)', target: 111.32, tLbl: 'ADJ TARGET 111.32 (gap fill)' },
];

async function drawLine(c, price, color, text) {
  await run(c, `(function(){var ch=window.TradingViewApi.activeChart();ch.createShape({time:Math.floor(Date.now()/1000),price:${price}},{shape:'horizontal_line',lock:true,disableSelection:false,overrides:{linecolor:'${color}',linestyle:0,linewidth:2,showLabel:true,text:'${text}',textcolor:'${color}',fontsize:10,horzLabelsAlign:'right',showPrice:true}})})()`);
}
async function clearPlay(c) {
  await run(c, `(function(){var ch=window.TradingViewApi.activeChart();var s=ch.getAllShapes();for(var i=0;i<s.length;i++){try{var p=ch.getShapeById(s[i].id).getProperties();var col=(p.linecolor||p.color||'').toLowerCase();if(s[i].name==='horizontal_line'&&(col==='#00e676'||col==='#e040fb'||col==='#ff5252'))ch.removeEntity(s[i].id);}catch(e){}}})()`);
}

(async () => {
  const c = await CDP({ port: 9222 }); await c.Runtime.enable();

  // Remember the user's current chart symbol so we can restore it afterward.
  const original = await run(c, `window.TradingViewApi.activeChart().symbol()`);

  for (const a of ADJ) {
    await run(c, `window.TradingViewApi.activeChart().setSymbol('${a.sym}')`); await sleep(1500);
    await run(c, `window.TradingViewApi.activeChart().setResolution('D')`); await sleep(1800);
    const resolved = await run(c, `window.TradingViewApi.activeChart().symbol()`);
    await clearPlay(c);
    await drawLine(c, a.entry, ENTRY, a.eLbl);
    await drawLine(c, a.target, TARGET, a.tLbl);
    console.log(`${a.sym} -> ${resolved}: ${a.eLbl} / ${a.tLbl}`);
  }

  // Restore the user's original chart symbol so we don't disrupt their session.
  if (original) { await run(c, `window.TradingViewApi.activeChart().setSymbol('${original}')`); await sleep(800); }
  console.log(`restored chart to: ${original}`);

  // Probe: can we read QQQ's live price from the watchlist DOM WITHOUT switching the chart?
  const probe = await run(c, `(function(){
    var rows = document.querySelectorAll('[data-symbol-full]');
    for (var i=0;i<rows.length;i++){
      var sf = rows[i].getAttribute('data-symbol-full')||'';
      if (sf.indexOf('QQQ')>-1){
        // walk up to the row container, grab the last-price cell text
        var row = rows[i].closest('[class*="row"]') || rows[i].parentElement;
        var txt = row ? row.innerText.replace(/\\n/g,' | ') : '(no row)';
        return { found:true, symbolFull:sf, rowText:txt };
      }
    }
    return { found:false, count:rows.length };
  })()`);
  console.log('QQQ DOM probe:', JSON.stringify(probe));

  await c.close(); process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
