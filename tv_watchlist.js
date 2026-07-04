#!/usr/bin/env node
/**
 * tv_watchlist.js — CLI helper สำหรับ watchlist_tv.py
 * Usage: node tv_watchlist.js <list_name> <symbols_json>
 *   list_name    : ชื่อ watchlist เช่น "Focus", "Watch", "Accum"
 *   symbols_json : JSON array เช่น '["BINANCE:BTCUSDT.P","BINANCE:ETHUSDT.P"]'
 *
 * Output: JSON { success, added, removed, total, error }
 *
 * Strategy: เรียก TradingView REST API ผ่าน fetch() ใน browser context
 *   → ใช้ browser session cookies อัตโนมัติ (ไม่ต้องดึง cookies เอง)
 *   → ทำงานได้แม้ TradingView เปิดใน Chrome แบบปกติ (ไม่ต้อง CDP port 9222)
 */

import { evaluate } from './src/connection.js';

const [,, listName, symbolsJson] = process.argv;

if (!listName || !symbolsJson) {
  process.stdout.write(JSON.stringify({
    success: false,
    error: 'Usage: node tv_watchlist.js <list_name> <symbols_json>'
  }) + '\n');
  process.exit(1);
}

let targetSymbols;
try {
  targetSymbols = JSON.parse(symbolsJson);
} catch (e) {
  process.stdout.write(JSON.stringify({ success: false, error: `Invalid JSON: ${e.message}` }) + '\n');
  process.exit(1);
}

// ── Evaluate helper (store result in window global, poll it back) ─────────────

async function evalAsync(js) {
  // เซ็ต sentinel ก่อน เพื่อรู้ว่า fetch เสร็จแล้ว
  const key = `__tv_wl_${Date.now()}`;
  await evaluate(`window['${key}'] = '__pending__'; ${js}.then(r => { window['${key}'] = r; }).catch(e => { window['${key}'] = {__error: e.message}; });`);

  // Poll ทุก 200ms จนกว่าจะมีผล (timeout 15s)
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    const raw = await evaluate(`JSON.stringify(window['${key}'])`);
    if (raw && raw !== '"__pending__"') {
      try { return JSON.parse(JSON.parse(raw)); } catch { return JSON.parse(raw); }
    }
  }
  throw new Error('evalAsync timeout');
}

// ── TV REST API helpers ────────────────────────────────────────────────────────

const TV_BASE = 'https://in.tradingview.com';

async function getAllLists() {
  return evalAsync(`fetch('${TV_BASE}/api/v1/symbols_list/custom/', {credentials:'include'}).then(r=>r.json())`);
}

function getCsrf() {
  return evaluate(`document.cookie.match(/csrftoken=([^;]+)/)?.[1] || ''`);
}

async function apiPost(path, body) {
  const csrf = await getCsrf();
  return evalAsync(`fetch('${TV_BASE}${path}', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRFToken': ${JSON.stringify(csrf || '')}
    },
    body: JSON.stringify(${JSON.stringify(body)})
  }).then(r => r.ok ? r.json().catch(()=>({ok:true,status:r.status})) : r.text().then(t=>({__httpError:r.status,body:t.slice(0,200)})))`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  // 1. ดึง watchlists ทั้งหมด
  const lists = await getAllLists();
  if (!Array.isArray(lists)) {
    throw new Error(`getAllLists returned: ${JSON.stringify(lists)}`);
  }
  process.stderr.write(`[wl] Found ${lists.length} lists: ${lists.map(l=>l.name).join(', ')}\n`);

  // 2. หา list ที่ต้องการ (exact → partial)
  let existing = lists.find(l => l.name === listName)
                || lists.find(l => l.name.includes(listName));

  let listId;
  if (existing) {
    listId = existing.id;
    process.stderr.write(`[wl] Found '${existing.name}' (id=${listId})\n`);
  } else {
    // สร้างใหม่
    process.stderr.write(`[wl] Creating new list '${listName}'...\n`);
    const created = await evalAsync(`fetch('${TV_BASE}/api/v1/symbols_list/custom/', {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type':'application/json','X-CSRFToken': document.cookie.match(/csrftoken=([^;]+)/)?.[1]||''},
      body: JSON.stringify({name:${JSON.stringify(listName)}, symbols:[]})
    }).then(r=>r.json())`);
    if (!created || !created.id) throw new Error(`Create list failed: ${JSON.stringify(created)}`);
    listId = created.id;
    existing = { symbols: [] };
    process.stderr.write(`[wl] Created '${listName}' (id=${listId})\n`);
  }

  // 3. เปรียบเทียบ current vs target
  const currentSet  = new Set(existing.symbols || []);
  const targetSet   = new Set(targetSymbols);
  const toRemove    = [...currentSet].filter(s => !targetSet.has(s));
  const toAdd       = targetSymbols.filter(s => !currentSet.has(s));

  process.stderr.write(`[wl] current=${currentSet.size} target=${targetSet.size} remove=${toRemove.length} add=${toAdd.length}\n`);

  // 4. Remove
  if (toRemove.length > 0) {
    const r = await apiPost(`/api/v1/symbols_list/custom/${listId}/remove/`, toRemove);
    process.stderr.write(`[wl] remove result: ${JSON.stringify(r)}\n`);
  }

  // 5. Add
  if (toAdd.length > 0) {
    const r = await apiPost(`/api/v1/symbols_list/custom/${listId}/append/?source=web-tvd`, toAdd);
    process.stderr.write(`[wl] add result: ${JSON.stringify(r)}\n`);
  }

  process.stdout.write(JSON.stringify({
    success: true,
    added:   toAdd.length,
    removed: toRemove.length,
    total:   targetSymbols.length,
  }) + '\n');
  process.exit(0);

} catch (err) {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }) + '\n');
  process.exit(1);
}
