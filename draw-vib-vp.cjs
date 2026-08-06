const CDP = require('chrome-remote-interface');
const fs  = require('fs');
const VP  = JSON.parse(fs.readFileSync('vib_vp.json', 'utf8'));

(async () => {
  const client = await CDP({ port: 9222 });
  const { Runtime, Page } = client;
  await Page.enable();

  // Switch to VIB Daily
  await Runtime.evaluate({
    expression: `
      const api = window.TradingViewApi;
      const chart = api.chart();
      chart.setSymbol('HOSE:VIB', () => {});
    `
  });
  await new Promise(r => setTimeout(r, 2500));

  // Switch to Daily timeframe
  await Runtime.evaluate({
    expression: `
      try {
        const chart = window.TradingViewApi.chart();
        chart.setResolution('1D', () => {});
      } catch(e) {}
    `
  });
  await new Promise(r => setTimeout(r, 1500));

  // Clear old horizontal lines
  await Runtime.evaluate({ expression: `
    try {
      const chart = window.TradingViewApi.chart();
      chart.getAllShapes().forEach(s => {
        if (s.name === 'horizontal_line') {
          try { chart.removeEntity(s.id); } catch(e) {}
        }
      });
    } catch(e) {}
  `});

  const LEVELS = [
    { price: VP.va_high, label: `VA High ${VP.va_high.toLocaleString()}`, color: '#2196F3', width: 2, style: 1 },
    { price: 18500,      label: 'HVN 18,500',                             color: '#9C27B0', width: 1, style: 2 },
    { price: VP.poc,     label: `POC ${VP.poc.toLocaleString()}`,         color: '#FF5722', width: 3, style: 0 },
    { price: 16639,      label: 'Double Top / PH1 16,639',                color: '#FFC107', width: 2, style: 1 },
    { price: VP.va_low,  label: `VA Low ${VP.va_low.toLocaleString()}`,   color: '#26A69A', width: 2, style: 1 },
  ];

  const results = [];
  for (const lvl of LEVELS) {
    const r = await Runtime.evaluate({ expression: `
      (function() {
        try {
          const chart = window.TradingViewApi.chart();
          const id = chart.createShape(
            { price: ${lvl.price} },
            {
              shape: 'horizontal_line',
              text: '${lvl.label}',
              overrides: {
                linecolor: '${lvl.color}',
                linewidth:  ${lvl.width},
                linestyle:  ${lvl.style},
                showLabel: true,
                horzLabelsAlign: 'right',
                textcolor: '${lvl.color}',
                fontsize: 13,
                bold: ${lvl.width >= 3},
              }
            }
          );
          return 'OK';
        } catch(e) { return 'ERR:' + e.message; }
      })()
    `});
    const val = r.result?.value || '?';
    console.log(`${val.padEnd(5)} ${lvl.label}`);
    results.push(val);
    await new Promise(r => setTimeout(r, 350));
  }

  await new Promise(r => setTimeout(r, 1200));

  // Screenshot
  const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 82 });
  const path = `screenshots/VIB_vp_${Date.now()}.jpg`;
  fs.mkdirSync('screenshots', { recursive: true });
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('Screenshot:', path);
  console.log('Done:', results.filter(r => r === 'OK').length + '/' + LEVELS.length + ' lines drawn');

  await client.close();
})().catch(e => console.error('Fatal:', e.message));
