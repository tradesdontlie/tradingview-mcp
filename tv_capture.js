#!/usr/bin/env node
/**
 * tv_capture.js — CLI helper for screenshotter.py
 * Usage: node tv_capture.js <symbol> <tf> <filename>
 * Output: JSON { success, file_path, error }
 *
 * Strategy:
 *  1. setSymbol()    — chart.setSymbol() API + waitForChartReady()
 *  2. setTimeframe() — chart.setResolution() API + waitForChartReady()
 *  3. Page.captureScreenshot (full page) → sips crop ด้วย physical pixels
 *     (CDP clip coordinates ให้ผลผิดบน Retina — crop ด้วย sips แทน)
 */

import { setSymbol, setTimeframe } from './src/core/chart.js';
import { evaluate, evaluateAsync, getClient, getTargetInfo } from './src/connection.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { platform } from 'os';

const IS_WIN = platform() === 'win32';

const SCREENSHOT_DIR = '/Users/rattanon/tradingview-mcp/screenshots';

const [,, symbol, tf, filename] = process.argv;

if (!symbol || !tf || !filename) {
  process.stdout.write(JSON.stringify({ success: false, error: 'Usage: node tv_capture.js <symbol> <tf> <filename>' }) + '\n');
  process.exit(1);
}

// ── Activate target (ป้องกัน rAF throttling สำหรับ background tabs) ──────────

async function activateTarget() {
  try {
    const info = await getTargetInfo();
    if (info && info.id) {
      await fetch(`http://localhost:9222/json/activate/${info.id}`);
      process.stderr.write(`[activate] Target ${info.id.substring(0, 8)}... activated\n`);
    }
  } catch (e) {
    process.stderr.write(`[activate] Failed: ${e.message}\n`);
  }
}

// ── Bring TradingView to OS foreground (เพื่อเปิด rAF) ───────────────────────

async function bringToForeground() {
  try {
    if (IS_WIN) {
      // Windows: ใช้ PowerShell focus window ด้วย AppActivate
      // หา Edge หรือ Chrome ที่เปิด TradingView อยู่ (มี MainWindowTitle)
      execSync(
        `powershell -NoProfile -NonInteractive -Command ` +
        `"$proc = Get-Process -Name msedge,chrome,TradingView -ErrorAction SilentlyContinue ` +
        `| Where-Object {$_.MainWindowTitle -ne ''} | Select-Object -First 1; ` +
        `if ($proc) { ` +
        `  Add-Type -AssemblyName Microsoft.VisualBasic; ` +
        `  [Microsoft.VisualBasic.Interaction]::AppActivate($proc.Id) ` +
        `}"`,
        { timeout: 5000 }
      );
    } else {
      // macOS: AppleScript
      execSync(`osascript -e 'tell application "TradingView" to activate'`, { timeout: 3000 });
    }
    process.stderr.write(`[focus] TradingView activated\n`);
    await new Promise(r => setTimeout(r, 400));  // รอ focus transition
  } catch (e) {
    process.stderr.write(`[focus] bringToForeground failed: ${e.message}\n`);
  }
}

// ── รอให้ canvas repaint จริง (ผ่าน rAF) ─────────────────────────────────────

async function waitForCanvasRepaint() {
  // 1. Bring TradingView window to OS foreground → rAF ทำงานที่ full speed
  await bringToForeground();

  // 2. Dispatch resize เพื่อ trigger TradingView repaint schedule
  try { await evaluate(`window.dispatchEvent(new Event('resize'))`); } catch {}

  // 3. รอ 5 rAF cycles (ตอนนี้ rAF ทำงานได้เพราะ window อยู่ foreground)
  //    TradingView render chart ผ่าน rAF → 5 cycles (~83ms@60fps) มากพอ
  try {
    await evaluateAsync(`new Promise(r => {
      var n = 0;
      function tick() { if (++n >= 5) r(); else requestAnimationFrame(tick); }
      requestAnimationFrame(tick);
    })`);
    process.stderr.write(`[repaint] rAF cycles done\n`);
  } catch {
    await new Promise(r => setTimeout(r, 300));
    process.stderr.write(`[repaint] rAF fallback setTimeout\n`);
  }

  // 4. Buffer เพิ่ม 200ms เผื่อ TradingView มี post-render processing
  await new Promise(r => setTimeout(r, 200));
}

// ── Dismiss popups ────────────────────────────────────────────────────────────

async function dismissPopups() {
  await evaluate(`
    (function() {
      var evt = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true });
      document.dispatchEvent(evt);
      var closeBtn = document.querySelector('[data-name="close"]') ||
                     document.querySelector('[class*="closeButton"]') ||
                     document.querySelector('[aria-label="Close"]');
      if (closeBtn) closeBtn.click();
    })()`);
  await new Promise(r => setTimeout(r, 400));
}

// ── Get chart bounds รวม header (CSS pixels) ──────────────────────────────────

async function getChartBoundsWithHeader() {
  return await evaluate(`
    (function() {
      var panes = Array.from(document.querySelectorAll('[data-name="pane-canvas"]'));
      if (!panes[0]) return null;

      var firstR = panes[0].getBoundingClientRect();
      var lastR  = panes[panes.length - 1].getBoundingClientRect();
      var panesH = (lastR.top + lastR.height) - firstR.top + 16;

      // หา header bar (symbol name + TF buttons)
      var header = document.querySelector('[data-name="header-toolbar"]')
                || document.querySelector('[data-name="legend"]')
                || document.querySelector('[class*="headerWrapper"]')
                || document.querySelector('[class*="chart-toolbar"]');

      var headerH = 0;
      if (header) {
        var hRect = header.getBoundingClientRect();
        if (hRect.bottom <= firstR.top + 5) {
          headerH = firstR.top - hRect.top;
        }
      }
      if (headerH <= 0) headerH = Math.min(firstR.top, 48);

      var y = Math.max(0, firstR.top - headerH);
      return {
        x:      firstR.left,
        y:      y,
        width:  firstR.width,
        height: panesH + (firstR.top - y),
      };
    })()`);
}

// ── Capture ด้วย Page.captureScreenshot + clip ───────────────────────────────
// (ใช้ได้เพราะ waitForCanvasRepaint ทำให้ window อยู่ foreground + rAF render แล้ว)
// ข้อดี: รวม header toolbar (symbol name + TF buttons) ด้วย

async function captureAndCrop(filePath) {
  const c = await getClient();

  // Get chart bounds รวม header (CSS pixels)
  const bounds = await getChartBoundsWithHeader();
  if (!bounds) throw new Error('ไม่พบ chart bounds');

  const dpr = (await evaluate(`window.devicePixelRatio || 1`)) || 2;

  // Capture ด้วย CDP clip — DIP coordinates, scale=dpr สำหรับ Retina
  const { data } = await c.Page.captureScreenshot({
    format: 'png',
    fromSurface: true,
    clip: {
      x:      bounds.x,
      y:      bounds.y,
      width:  bounds.width,
      height: bounds.height,
      scale:  dpr,
    },
  });

  if (!data) throw new Error('Page.captureScreenshot คืน null');

  const buf = Buffer.from(data, 'base64');
  writeFileSync(filePath, buf);
  process.stderr.write(`[capture] screenshot size=${buf.length}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  // 0. Dismiss popups ก่อนเริ่ม
  await dismissPopups();

  // 1. Switch symbol — API + waitForChartReady()
  const symResult = await setSymbol({ symbol });
  process.stderr.write(`[symbol] ${symResult.symbol} ready=${symResult.chart_ready}\n`);
  await new Promise(r => setTimeout(r, 300));

  // 2. Dismiss popup อีกรอบ
  await dismissPopups();

  // 2b. Activate target เพื่อให้ rAF ทำงานที่ full speed (ไม่ throttle background tab)
  await activateTarget();

  // 3. Switch TF — setResolution() API + waitForChartReady()
  const tfResult = await setTimeframe({ timeframe: tf });
  process.stderr.write(`[tf] ${tf} ready=${tfResult.chart_ready}\n`);

  // 4. รอจนกว่า chart จะโหลด DATA จริง (ไม่ใช่แค่ toolbar update)
  //    ตรวจสอบ mainSeries().bars().size() ให้ stable ก่อน capture
  const SETTLE_TIMEOUT = 12000;
  const SETTLE_POLL    = 300;
  let settleElapsed = 0;
  const symUpper = symbol.toUpperCase().replace(/USDT$/, '');  // "ALGOUSDT" → "ALGO"

  let prevBarsSize = -1;
  let stableCount  = 0;
  const STABLE_NEEDED = 3;  // bars count ต้องเท่ากัน 3 รอบติดกัน = 900ms stable

  while (settleElapsed < SETTLE_TIMEOUT) {
    await new Promise(r => setTimeout(r, SETTLE_POLL));
    settleElapsed += SETTLE_POLL;

    const rawState = await evaluate(`
      (function() {
        try {
          var api = window.TradingViewApi;
          if (!api || !api._activeChartWidgetWV) return JSON.stringify({sym:'',res:'',bars:0,barDur:0});
          var w = api._activeChartWidgetWV.value && api._activeChartWidgetWV.value();
          if (!w) return JSON.stringify({sym:'',res:'',bars:0,barDur:0});
          var sym = (w.symbol ? w.symbol() : '').toUpperCase();
          var res = w.resolution ? w.resolution() : '';
          var bars = 0, barDur = 0;
          try {
            var m = w._chartWidget && w._chartWidget.model();
            if (m) {
              var bs = m.mainSeries().bars();
              bars = bs.size();
              // ตรวจสอบ bar duration จาก timestamp diff ของ 2 bars ล่าสุด
              var li = bs.lastIndex(), fi = bs.firstIndex();
              if (li - fi >= 2) {
                var t1 = bs.valueAt(li);
                var t2 = bs.valueAt(li - 1);
                if (t1 && t2) barDur = t1[0] - t2[0];
              }
            }
          } catch {}
          return JSON.stringify({sym:sym, res:res, bars:bars, barDur:barDur});
        } catch(e) {
          return JSON.stringify({sym:'',res:'',bars:0,barDur:0,err:e.message});
        }
      })()
    `);

    let chartSym = '', chartRes = '', barsSize = 0, barDur = 0;
    try { const s = JSON.parse(rawState); chartSym=s.sym; chartRes=s.res; barsSize=s.bars; barDur=s.barDur; } catch {}

    const symOk   = chartSym && chartSym.includes(symUpper);
    const resOk   = chartRes === tf;
    // ตรวจ bar duration: tf=30→1800s, tf=60→3600s, tf=240→14400s
    const expectedDur = parseInt(tf) * 60;
    const durOk   = barDur === expectedDur;

    if (symOk && resOk && durOk && barsSize > 0) {
      if (barsSize === prevBarsSize) {
        stableCount++;
      } else {
        stableCount = 1;
        prevBarsSize = barsSize;
      }
    } else {
      stableCount  = 0;
      prevBarsSize = barsSize;
    }

    process.stderr.write(`[settle] ${settleElapsed}ms sym="${chartSym}" res="${chartRes}" barDur=${barDur}(want=${expectedDur}) bars=${barsSize} stable=${stableCount}/${STABLE_NEEDED}\n`);

    if (symOk && resOk && durOk && stableCount >= STABLE_NEEDED) {
      process.stderr.write(`[settle] data ready — bars=${barsSize} barDur=${barDur}\n`);
      break;
    }
  }
  if (settleElapsed >= SETTLE_TIMEOUT) {
    process.stderr.write(`[settle] timeout — capture anyway\n`);
  }

  // 4b. รอให้ canvas repaint จริง (ผ่าน rAF) ก่อน capture
  await waitForCanvasRepaint();

  // 5. Capture (retry ถ้าไฟล์เล็กเกินไป — อาจ canvas ยัง blank)
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const filePath = join(SCREENSHOT_DIR, `${filename}.png`);

  const MAX_ATTEMPTS = 3;
  const MIN_SIZE_KB   = 60;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await captureAndCrop(filePath);
    const { statSync } = await import('fs');
    const sizeKb = statSync(filePath).size / 1024;
    process.stderr.write(`[capture] attempt ${attempt} size=${Math.round(sizeKb * 1024)}\n`);
    if (sizeKb >= MIN_SIZE_KB) break;
    if (attempt < MAX_ATTEMPTS) {
      process.stderr.write(`[capture] too small (${Math.round(sizeKb)}KB < ${MIN_SIZE_KB}KB), retrying...\n`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  process.stdout.write(JSON.stringify({ success: true, file_path: filePath }) + '\n');
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }) + '\n');
  process.exit(1);
}
