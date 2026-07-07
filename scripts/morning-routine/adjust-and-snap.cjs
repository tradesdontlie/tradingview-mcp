#!/usr/bin/env node
/**
 * Adjust INTC/TSM play lines + snapshot QQQ at the PM-low line.
 *
 * - Re-marks INTC and TSM: clears old green/purple play lines, draws ADJ entry/target
 *   derived from this morning's structure (PM high / gap fill).
 * - Captures a QQQ intraday screenshot to eyeball whether the 715 PM low is holding.
 *
 * Levels are structure-derived suggestions (educational), labeled "ADJ".
 */

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

const ENTRY_COLOR = '#00E676';   // green
const TARGET_COLOR = '#E040FB';  // purple

const ADJ = [
  { sym: 'NASDAQ:INTC', entry: 133.00, entryLabel: 'ADJ ENTRY 133.00 (PMH reclaim)', target: 140.86, targetLabel: 'ADJ TARGET 140.86 (gap fill)' },
  { sym: 'NYSE:TSM',    entry: 450.00, entryLabel: 'ADJ ENTRY 450.00 (reclaim)',     target: 465.25, targetLabel: 'TARGET 465.25 (gap fill)' },
];

const SHOT_DIR = path.join(__dirname, '..', '..', 'screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run(client, expr) {
  const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
  return r && r.result ? r.result.value : null;
}

async function drawLine(client, price, color, text) {
  await run(client, `(function(){var chart=window.TradingViewApi.activeChart();chart.createShape({time:Math.floor(Date.now()/1000),price:${price}},{shape:'horizontal_line',lock:true,disableSelection:false,overrides:{linecolor:'${color}',linestyle:0,linewidth:2,showLabel:true,text:'${text.replace(/'/g, "")}',textcolor:'${color}',fontsize:10,horzLabelsAlign:'right',showPrice:true}})})()`);
}

async function clearPlayLines(client) {
  await run(client, `(function(){
    var chart=window.TradingViewApi.activeChart();
    var shapes=chart.getAllShapes();
    for(var i=0;i<shapes.length;i++){var s=shapes[i];
      try{var p=chart.getShapeById(s.id).getProperties();var c=(p.linecolor||p.color||'').toLowerCase();
        if(s.name==='horizontal_line' && (c==='#00e676'||c==='#e040fb'||c==='#ff5252')){chart.removeEntity(s.id);}
      }catch(e){}}
  })()`);
}

(async () => {
  const client = await CDP({ port: 9222 });
  await client.Runtime.enable();
  await client.Page.enable();

  // --- Adjust INTC + TSM ---
  for (const a of ADJ) {
    await run(client, `window.TradingViewApi.activeChart().setSymbol('${a.sym}')`);
    await sleep(1500);
    await run(client, `window.TradingViewApi.activeChart().setResolution('D')`);
    await sleep(2000);
    const resolved = await run(client, `window.TradingViewApi.activeChart().symbol()`);
    await clearPlayLines(client);
    await drawLine(client, a.entry, ENTRY_COLOR, a.entryLabel);
    await drawLine(client, a.target, TARGET_COLOR, a.targetLabel);
    console.log(`${a.sym} -> ${resolved}: drew ${a.entryLabel} / ${a.targetLabel}`);
  }

  // --- QQQ intraday screenshot at the PM-low (~715) line ---
  await run(client, `window.TradingViewApi.activeChart().setSymbol('NASDAQ:QQQ')`);
  await sleep(1500);
  await run(client, `window.TradingViewApi.activeChart().setResolution('15')`);
  await sleep(2500);
  const qqqSym = await run(client, `window.TradingViewApi.activeChart().symbol()`);
  // Draw a reference line at 715 (today's PM low) so it's visible in the shot
  await drawLine(client, 715.56, '#FFD600', 'PM LOW 715.56');
  await sleep(1500);
  const shot = await client.Page.captureScreenshot({ format: 'png' });
  const file = path.join(SHOT_DIR, `qqq-715-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const last = await run(client, `(function(){try{var s=window.TradingViewApi.activeChart()._chartWidget.model().mainSeries();var b=s.bars();var arr=[];b.each(function(t,bar){arr.push(bar[4])});return arr[arr.length-1];}catch(e){return null;}})()`);
  console.log(`QQQ snapshot (${qqqSym}) saved: ${file}`);
  console.log(`QQQ last price: ${last}`);

  await client.close();
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
