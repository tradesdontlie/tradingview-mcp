/**
 * Pine Profiler core logic.
 *
 * The Pine Profiler is a TradingView UI feature (Pine Editor → "..." menu →
 * Developer Tools → Profiler Mode) that overlays per-line execution metrics
 * on the editor and renders a side panel with cost rows. There is no public
 * Pine API for the profiler — these tools drive the UI via CDP and read
 * rendered DOM.
 *
 * Selector strategy: TradingView ships UI changes frequently. Each step
 * (open menu, click item, parse rows) tries multiple selector patterns
 * before giving up, and `probeProfilerDom` exposes the raw landscape so
 * humans can adapt selectors after a TV release without code spelunking.
 */
import { evaluate } from '../connection.js';
import { ensurePineEditorOpen } from './pine.js';

const SLEEP_AFTER_MENU_OPEN_MS = 300;
const SLEEP_AFTER_TOGGLE_MS = 900;
const SLEEP_AFTER_DISABLE_MS = 500;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Returns true if profiler mode appears to be active.
 *
 * Detection is heuristic — checks (in order):
 *   1) any visible element with data-name or class containing "profiler"
 *   2) any menu item with role=menuitemcheckbox + aria-checked=true + text matches /profil/i
 *   3) any visible Monaco line decoration whose class hints at execution timing
 */
async function isProfilerEnabled() {
  return await evaluate(`
    (function() {
      var direct = document.querySelectorAll('[data-name*="profiler" i], [class*="profiler" i]');
      for (var i = 0; i < direct.length; i++) {
        if (direct[i].offsetParent !== null) return true;
      }
      var checks = document.querySelectorAll('[role="menuitemcheckbox"][aria-checked="true"], [role="menuitemradio"][aria-checked="true"]');
      for (var j = 0; j < checks.length; j++) {
        if (/profil/i.test(checks[j].textContent || '')) return true;
      }
      var monaco = document.querySelector('.monaco-editor.pine-editor-monaco');
      if (monaco) {
        var deco = monaco.querySelector('[class*="execution-time"], [class*="executionTime"]');
        if (deco && deco.offsetParent !== null) return true;
      }
      return false;
    })()
  `);
}

/**
 * Open the Pine Editor's "..." (more options) menu next to the Publish Script
 * button. Returns { opened: bool, reason?: string }.
 */
async function openMoreMenu() {
  return await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }

      // 1) Highest-confidence Pine Editor selector: the next sibling button
      // after publishButton in the editor toolbar. Tried FIRST because
      // toolbar order (Save | Publish | "...") is fixed across TV releases,
      // and broader [aria-label="More"] selectors match many unrelated buttons
      // elsewhere in the page (chart More, watchlist More, etc.).
      var pub = document.querySelector('[class*="publishButton"]');
      if (visible(pub)) {
        var par = pub.parentElement;
        if (par) {
          var sibs = par.querySelectorAll('button');
          var pubSeen = false;
          for (var p = 0; p < sibs.length; p++) {
            if (sibs[p] === pub) { pubSeen = true; continue; }
            if (pubSeen && visible(sibs[p])) {
              sibs[p].click();
              return { opened: true, via: 'publishButton-next-sibling' };
            }
          }
        }
      }

      // 2) Named data-name / aria selectors as fallback
      var named = [
        '[data-name="pine-editor-more-button"]',
        '[data-name="pineEditor-more"]',
        '[data-name="more-button"]',
      ];
      for (var s = 0; s < named.length; s++) {
        var el = document.querySelector(named[s]);
        if (visible(el)) { el.click(); return { opened: true, via: named[s] }; }
      }

      // 2) Search inside Pine Editor / bottom-widgetbar header for kebab buttons
      var headerSelectors = [
        '.pine-editor-container [class*="header"]',
        '[class*="pine-editor"] [class*="header"]',
        '[class*="bottom-widgetbar"] [class*="header"]',
        '[class*="bottom-widgetbar-content"]',
      ];
      for (var h = 0; h < headerSelectors.length; h++) {
        var headers = document.querySelectorAll(headerSelectors[h]);
        for (var k = 0; k < headers.length; k++) {
          var btns = headers[k].querySelectorAll('button, [role="button"]');
          for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (!visible(b)) continue;
            var aria = (b.getAttribute('aria-label') || '').toLowerCase();
            var dn = (b.getAttribute('data-name') || '').toLowerCase();
            if (aria.indexOf('more') !== -1 || dn.indexOf('more') !== -1) {
              b.click();
              return { opened: true, via: 'header-aria-more' };
            }
          }
        }
      }

      // 3) Last-resort: any visible aria-label "More" element inside something pine-y
      var allMore = document.querySelectorAll('[aria-label*="More" i]');
      for (var m = 0; m < allMore.length; m++) {
        if (!visible(allMore[m])) continue;
        if (allMore[m].closest('[class*="pine"], [class*="bottom-widgetbar"]')) {
          allMore[m].click();
          return { opened: true, via: 'fallback-more-near-pine' };
        }
      }

      return { opened: false, reason: 'three-dot menu button not found near Pine Editor' };
    })()
  `);
}

/**
 * Find the "Profiler Mode" item in the open menu, read its checked state, and
 * optionally click it to match the requested mode.
 *   mode = 'on'      → click only if currently unchecked
 *   mode = 'off'     → click only if currently checked
 *   mode = 'toggle'  → click unconditionally
 */
async function clickProfilerMenuItem(mode) {
  const modeJson = JSON.stringify(mode);
  return await evaluate(`
    (function() {
      var mode = ${modeJson};
      function visible(el) { return el && el.offsetParent !== null; }

      var item = null;
      var via = null;

      var roleItems = document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]');
      for (var i = 0; i < roleItems.length; i++) {
        if (!visible(roleItems[i])) continue;
        var t = (roleItems[i].textContent || '').trim();
        if (/profil/i.test(t) && t.length < 80) { item = roleItems[i]; via = 'role-menuitem'; break; }
      }

      if (!item) {
        var menus = document.querySelectorAll('[class*="menu"], [class*="dropdown"], [class*="popup"]');
        for (var mIdx = 0; mIdx < menus.length; mIdx++) {
          if (!visible(menus[mIdx])) continue;
          var nodes = menus[mIdx].querySelectorAll('[class*="item"], [class*="row"], button, [role="button"]');
          for (var j = 0; j < nodes.length; j++) {
            if (!visible(nodes[j])) continue;
            var txt = (nodes[j].textContent || '').trim();
            if (/profil/i.test(txt) && txt.length < 80) { item = nodes[j]; via = 'menu-class-item'; break; }
          }
          if (item) break;
        }
      }

      if (!item) return { found: false };

      var checked = item.getAttribute('aria-checked') === 'true';
      if (!checked) {
        var inner = item.querySelector('[class*="checked"], [aria-checked="true"], [class*="enabled"]');
        if (inner) checked = true;
      }

      var shouldClick = (mode === 'toggle')
        || (mode === 'on' && !checked)
        || (mode === 'off' && checked);

      if (shouldClick) item.click();

      return { found: true, was_checked: checked, clicked: shouldClick, via: via };
    })()
  `);
}

/**
 * Best-effort menu close (Escape via document body click).
 */
async function closeMenuFallback() {
  await evaluate(`
    (function() {
      var ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
      document.dispatchEvent(ev);
      return true;
    })()
  `);
}

export async function enableProfiler() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found.');

  const wasAlreadyEnabled = await isProfilerEnabled();
  if (wasAlreadyEnabled) {
    return { success: true, was_already_enabled: true, panel_visible: true };
  }

  const menu = await openMoreMenu();
  if (!menu?.opened) {
    throw new Error('Could not open Pine Editor "..." menu: ' + (menu?.reason || 'unknown'));
  }
  await sleep(SLEEP_AFTER_MENU_OPEN_MS);

  const click = await clickProfilerMenuItem('on');
  if (!click.found) {
    await closeMenuFallback();
    throw new Error('Profiler Mode menu item not found in dropdown — TradingView UI may have changed. Run pine_profiler_probe to inspect.');
  }
  await sleep(SLEEP_AFTER_TOGGLE_MS);

  const enabled = await isProfilerEnabled();
  return {
    success: enabled,
    was_already_enabled: false,
    panel_visible: enabled,
    menu_item_via: click.via || null,
  };
}

export async function disableProfiler() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found.');

  const wasEnabled = await isProfilerEnabled();
  if (!wasEnabled) {
    return { success: true, was_already_disabled: true };
  }

  const menu = await openMoreMenu();
  if (!menu?.opened) {
    throw new Error('Could not open Pine Editor "..." menu: ' + (menu?.reason || 'unknown'));
  }
  await sleep(SLEEP_AFTER_MENU_OPEN_MS);

  const click = await clickProfilerMenuItem('off');
  if (!click.found) {
    await closeMenuFallback();
    throw new Error('Profiler Mode menu item not found in dropdown — TradingView UI may have changed. Run pine_profiler_probe to inspect.');
  }
  await sleep(SLEEP_AFTER_DISABLE_MS);

  const stillEnabled = await isProfilerEnabled();
  return {
    success: !stillEnabled,
    was_already_disabled: false,
  };
}

/**
 * Read the profiler panel and return per-line metrics.
 *
 * The profiler renders timing data in (at least) two places:
 *   - inline gutter decorations on Monaco lines (per-line ms / pct)
 *   - a side panel listing the same data, often virtualized
 *
 * Parser tries panel rows first (they survive virtualization scrolling
 * relative to the editor cursor), then falls back to gutter decorations.
 */
export async function getProfilerData({ top_n } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found.');

  const enabled = await isProfilerEnabled();
  if (!enabled) {
    throw new Error('Profiler mode is not enabled. Call pine_profiler_enable first.');
  }

  const data = await evaluate(`
    (function() {
      function visible(el) { return el && el.offsetParent !== null; }

      // TradingView's Pine Profiler renders per-line cost as a horizontal bar
      // overlay column inside the editor. Each row = one code line.
      //   - Container:    <div class="container-mXbixDKH">
      //     <div class="content-mXbixDKH">
      //       <div class="barContainer-mXbixDKH">  ← one per line
      //         <div class="bar-mXbixDKH">          ← visual bar
      //         <div class="barText-mXbixDKH">N.N% ← cost as percent (only)
      // Line numbers come from Monaco's .line-numbers gutter; correlate by Y.
      // TV does not render raw ms in the DOM (only percent + visual bar width);
      // ms remains null unless we find a separate display.

      var rows = [];
      var via = null;

      var bars = document.querySelectorAll('[class*="barContainer-"]');
      var profBars = [];
      for (var b = 0; b < bars.length; b++) {
        if (!visible(bars[b])) continue;
        var txtEl = bars[b].querySelector('[class*="barText-"]');
        if (!txtEl) continue;
        var t = (txtEl.textContent || '').trim();
        if (!/^[\\d.,]+\\s*%$/.test(t)) continue;
        var rect = bars[b].getBoundingClientRect();
        var pctVal = parseFloat(t.replace(/,/g, '').replace('%',''));
        if (isNaN(pctVal)) continue;
        profBars.push({ y: rect.y, h: rect.height, pct: pctVal, raw: t });
      }

      if (profBars.length > 0) {
        via = 'editor-bar-overlay';

        var monaco = document.querySelector('.monaco-editor.pine-editor-monaco');
        var lineMap = [];
        if (monaco) {
          var lineEls = monaco.querySelectorAll('.line-numbers');
          for (var l = 0; l < lineEls.length; l++) {
            if (!visible(lineEls[l])) continue;
            var lr = lineEls[l].getBoundingClientRect();
            var ln = parseInt((lineEls[l].textContent || '').trim(), 10);
            if (!isNaN(ln)) lineMap.push({ y: lr.y, h: lr.height, line: ln });
          }
        }

        function nearestLine(by) {
          var best = null, bestDist = Infinity;
          for (var i = 0; i < lineMap.length; i++) {
            var d = Math.abs(lineMap[i].y - by);
            if (d < bestDist) { bestDist = d; best = lineMap[i]; }
          }
          if (!best || bestDist > (best.h || 18)) return null;
          return best.line;
        }

        for (var p2 = 0; p2 < profBars.length; p2++) {
          var pb = profBars[p2];
          var line = nearestLine(pb.y);
          rows.push({ line: line, ms: null, pct: pb.pct, raw: pb.raw });
        }
      }

      // Fallback: legacy panel-row search (kept for forward compatibility
      // if TV adds an explicit panel layout in the future)
      if (rows.length === 0) {
        var panel = null;
        var panelCandidates = document.querySelectorAll('[data-name*="profiler" i], [class*="profiler" i]');
        for (var pc = 0; pc < panelCandidates.length; pc++) {
          if (!visible(panelCandidates[pc])) continue;
          if (!panel || panelCandidates[pc].getBoundingClientRect().width > panel.getBoundingClientRect().width) {
            panel = panelCandidates[pc];
          }
        }
        if (panel) {
          var sel = '[role="row"], [class*="profiler-line"], [class*="profilerLine"], [class*="profilerRow"], [class*="profiler-row"], [class*="profiler__row"]';
          var rowEls = panel.querySelectorAll(sel);
          via = 'panel';
          for (var i = 0; i < rowEls.length; i++) {
            var rEl = rowEls[i];
            var text = (rEl.textContent || '').trim();
            if (!text) continue;
            var lineMatch = text.match(/(?:line\\s+)?(\\d+)\\b/i);
            var msMatch = text.match(/([\\d.,]+)\\s*ms/i);
            var pctMatch = text.match(/([\\d.,]+)\\s*%/);
            var line = lineMatch ? parseInt(lineMatch[1], 10) : null;
            var ms = msMatch ? parseFloat(msMatch[1].replace(/,/g, '')) : null;
            var pct = pctMatch ? parseFloat(pctMatch[1].replace(/,/g, '')) : null;
            if (line === null && ms === null && pct === null) continue;
            rows.push({ line: line, ms: ms, pct: pct, raw: text.substring(0, 200) });
          }
        }
      }

      return {
        rows: rows,
        total_execution_ms: null,
        bar_count: null,
        parsed_via: via,
      };
    })()
  `);

  let lines = data?.rows || [];
  lines.sort((a, b) => {
    const aw = (a.ms ?? 0) || (a.pct ?? 0);
    const bw = (b.ms ?? 0) || (b.pct ?? 0);
    return bw - aw;
  });

  const topN = (typeof top_n === 'number' && top_n > 0) ? top_n : null;
  if (topN !== null) lines = lines.slice(0, topN);

  return {
    success: true,
    total_execution_ms: data?.total_execution_ms ?? null,
    bar_count: data?.bar_count ?? null,
    parsed_via: data?.parsed_via ?? null,
    line_count: lines.length,
    lines,
    note: lines.length === 0
      ? 'No profiler rows parsed. Panel may be virtualized (try scrolling the panel) or DOM selectors may need updating after a TV release. Run pine_profiler_probe.'
      : undefined,
  };
}

/**
 * Read TradingView runtime warning/error banners attached to the chart pane.
 *
 * Pine has two distinct error surfaces:
 *   - compile-time markers → exposed by `pine_get_errors` (Monaco markers)
 *   - log.info / compile messages → exposed by `pine_get_console`
 *   - runtime banners (timeout, max bars back, loop limit, OOM) → THIS function
 *
 * Runtime banners render as overlay elements on the chart pane attached to a
 * specific study. They survive page state across reloads and are the only
 * indicator that a script hit TV's 40-second execution wall-clock limit.
 *
 * `severity_filter` ∈ { 'all', 'warning', 'error' } (default 'all').
 */
export async function getRuntimeWarnings({ severity_filter } = {}) {
  const filter = (severity_filter === 'warning' || severity_filter === 'error')
    ? severity_filter : 'all';
  const filterJson = JSON.stringify(filter);

  const result = await evaluate(`
    (function() {
      var filter = ${filterJson};
      function visible(el) { return el && el.offsetParent !== null; }

      var SELECTORS = [
        '[class*="study-error"]',
        '[class*="study-warning"]',
        '[class*="studyError"]',
        '[class*="studyWarning"]',
        '[class*="runtime-error"]',
        '[class*="runtimeError"]',
        '[class*="error-tooltip"]',
        '[class*="errorTooltip"]',
        '[role="alert"]',
        '[role="status"]',
        '[data-name*="study-error" i]',
        '[data-name*="study-warning" i]',
      ];

      var seen = new Set();
      var nodes = [];
      for (var s = 0; s < SELECTORS.length; s++) {
        var found = document.querySelectorAll(SELECTORS[s]);
        for (var i = 0; i < found.length; i++) {
          if (!visible(found[i])) continue;
          if (seen.has(found[i])) continue;
          seen.add(found[i]);
          nodes.push({ el: found[i], hit: SELECTORS[s] });
        }
      }

      function classifyCode(text) {
        var t = (text || '').toLowerCase();
        if (/40\\s*sec|too long to execute|execution time limit/.test(t)) return 'execution_timeout';
        if (/max[\\s_-]*bars[\\s_-]*back|bars back/.test(t)) return 'max_bars_back';
        if (/loop|infinite/.test(t)) return 'loop_limit';
        if (/memor|out of/.test(t)) return 'memory_limit';
        if (/array|index/.test(t)) return 'array_error';
        if (/division|divide/.test(t)) return 'division_error';
        if (/na\\b|n\\/a/.test(t)) return 'na_in_function';
        return 'unknown';
      }

      function classifySeverity(el, text) {
        var cls = (el.className && String(el.className) || '').toLowerCase();
        var role = (el.getAttribute && el.getAttribute('role') || '').toLowerCase();
        if (/error/.test(cls) || role === 'alert') return 'error';
        if (/warn/.test(cls) || role === 'status') return 'warning';
        if (/error|fail/.test((text || '').toLowerCase())) return 'error';
        return 'warning';
      }

      function findStudy(el) {
        var cur = el;
        for (var d = 0; d < 12 && cur; d++) {
          if (cur.getAttribute) {
            var dn = cur.getAttribute('data-name') || '';
            var aria = cur.getAttribute('aria-label') || '';
            if (/study/i.test(dn) && cur.textContent) return cur.getAttribute('data-study-name') || aria || null;
          }
          cur = cur.parentElement;
        }
        var hint = el.querySelector && el.querySelector('[class*="title"], [class*="study-name"]');
        if (hint) return (hint.textContent || '').trim().substring(0, 120);
        return null;
      }

      var warnings = [];
      for (var n = 0; n < nodes.length; n++) {
        var el = nodes[n].el;
        var raw = (el.textContent || '').trim();
        if (!raw) continue;

        var sev = classifySeverity(el, raw);
        if (filter !== 'all' && sev !== filter) continue;

        var code = classifyCode(raw);
        warnings.push({
          severity: sev,
          code: code,
          message: raw.substring(0, 500),
          study: findStudy(el),
          matched_selector: nodes[n].hit,
          raw: raw.substring(0, 1000),
        });
      }

      return { warnings: warnings };
    })()
  `);

  const warnings = result?.warnings || [];
  return {
    success: true,
    severity_filter: filter,
    warning_count: warnings.length,
    warnings,
    note: warnings.length === 0
      ? 'No runtime warning banners found on the chart pane. (Compile-time errors live in pine_get_errors / pine_get_console — this tool only reads runtime overlay banners.)'
      : undefined,
  };
}

/**
 * Discovery helper: dump the DOM landscape around the profiler so a human can
 * update selectors when TradingView ships a UI change. Not meant for routine
 * use — call when enable/disable/get_data report failure.
 */
export async function probeProfilerDom() {
  return await evaluate(`
    (function() {
      function describe(el, max) {
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return {
          tag: el.tagName ? el.tagName.toLowerCase() : null,
          class: el.className ? String(el.className).substring(0, 200) : null,
          data_name: el.getAttribute ? el.getAttribute('data-name') : null,
          aria_label: el.getAttribute ? el.getAttribute('aria-label') : null,
          role: el.getAttribute ? el.getAttribute('role') : null,
          text: ((el.textContent || '').trim()).substring(0, max || 80),
          visible: el.offsetParent !== null,
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        };
      }
      function many(sel, cap) {
        var nodes = document.querySelectorAll(sel);
        var out = [];
        var lim = Math.min(nodes.length, cap || 10);
        for (var i = 0; i < lim; i++) out.push(describe(nodes[i], 120));
        return { selector: sel, count: nodes.length, sampled: out };
      }
      return {
        profiler_anchors: many('[data-name*="profiler" i], [class*="profiler" i]', 15),
        more_buttons: many('[aria-label*="More" i], [data-name*="more" i]', 15),
        open_menus: many('[role="menu"], [class*="menu"][class*="open"], [class*="dropdown"][class*="open"]', 10),
        visible_menuitems: many('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]', 30),
        monaco_present: !!document.querySelector('.monaco-editor.pine-editor-monaco'),
      };
    })()
  `);
}
