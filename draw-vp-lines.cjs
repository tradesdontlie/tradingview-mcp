const CDP = require('chrome-remote-interface');
const fs  = require('fs');

const VP = JSON.parse(fs.readFileSync('vpb_vp.json', 'utf8'));

(async () => {
  const client = await CDP({ port: 9222 });
  const { Runtime, Page } = client;
  await Page.enable();

  // Explore TradingViewApi structure first
  const explore = await Runtime.evaluate({ expression: `
    (function() {
      try {
        const api = window.TradingViewApi;
        const keys = Object.keys(api);
        // Try to get active chart
        let chartInfo = 'no chart';
        if (api.activeChart) chartInfo = 'has activeChart fn: ' + typeof api.activeChart;
        if (api.chart) chartInfo = 'has chart: ' + typeof api.chart;
        return JSON.stringify({ keys: keys.slice(0, 20), chartInfo });
      } catch(e) { return 'ERR:' + e.message; }
    })()
  `});
  console.log('TVApi structure:', explore.result?.value);

  // Try to get chart and draw lines
  const drawResult = await Runtime.evaluate({ expression: `
    (function() {
      try {
        const api = window.TradingViewApi;

        // Try different ways to get chart
        let chart = null;
        if (typeof api.activeChart === 'function') chart = api.activeChart();
        else if (api.chart && typeof api.chart === 'function') chart = api.chart();
        else if (api.chart) chart = api.chart;

        if (!chart) {
          // Try _exposed_chartWidgetCollection
          const col = window._exposed_chartWidgetCollection;
          if (col) {
            const widgets = col.widgets ? col.widgets() : null;
            if (widgets && widgets.length) chart = widgets[0].chart ? widgets[0].chart() : widgets[0];
          }
        }

        if (!chart) return 'ERR: no chart found';

        const levels = [
          { price: ${VP.va_high}, label: 'VA High ${VP.va_high.toLocaleString()}', color: '#2196F3', width: 2, style: 1 },
          { price: ${VP.poc},     label: 'POC ${VP.poc.toLocaleString()}',          color: '#FF5722', width: 3, style: 0 },
          { price: ${VP.va_low},  label: 'VA Low ${VP.va_low.toLocaleString()}',    color: '#26A69A', width: 2, style: 1 },
        ];

        const results = [];
        for (const lvl of levels) {
          try {
            const id = chart.createShape(
              { price: lvl.price },
              {
                shape: 'horizontal_line',
                text: lvl.label,
                overrides: {
                  linecolor: lvl.color,
                  linewidth: lvl.width,
                  linestyle: lvl.style,
                  showLabel: true,
                  horzLabelsAlign: 'right',
                  textcolor: lvl.color,
                  fontsize: 13,
                  bold: lvl.width >= 3,
                }
              }
            );
            results.push('OK:' + lvl.label + ':' + id);
          } catch(e) {
            results.push('ERR:' + lvl.label + ':' + e.message);
          }
        }
        return results.join(' | ');
      } catch(e) { return 'FATAL:' + e.message; }
    })()
  `});
  console.log('Draw result:', drawResult.result?.value);

  await new Promise(r => setTimeout(r, 1500));

  // Screenshot
  const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 80 });
  const path = 'screenshots/VPB_vp_' + Date.now() + '.jpg';
  fs.writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('Screenshot:', path);

  await client.close();
})().catch(e => console.error('Fatal:', e.message));
