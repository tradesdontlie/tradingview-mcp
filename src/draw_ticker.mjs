import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.js');
const child = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], cwd: __dirname });

let id = 0;
const pending = new Map();
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => { try { const m = JSON.parse(line); if (m.id !== undefined) { const r = pending.get(m.id); if (r) { r(m); pending.delete(m.id); } } } catch(e) {} });
child.stderr.on('data', (d) => { const t = d.toString(); if (!t.includes('⚠') && !t.includes('tradingview-mcp')) process.stderr.write(t); });

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const reqId = ++id;
    pending.set(reqId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params }) + '\n');
    setTimeout(() => { if (pending.has(reqId)) { pending.delete(reqId); reject(new Error('Timeout')); } }, 20000);
  });
}

async function main() {
  const ticker = process.argv[2];
  const entryLo = parseInt(process.argv[3]);
  const entryHi = parseInt(process.argv[4]);
  const sl = parseInt(process.argv[5]);
  const tp1 = parseInt(process.argv[6]);
  const tp2 = parseInt(process.argv[7]);

  await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'draw', version: '1.0' } });
  await new Promise(r => setTimeout(r, 3000));

  const entryText = `ENTRY ${(entryLo/1000).toFixed(1)}-${(entryHi/1000).toFixed(1)}k`;
  const slText = `SL ${(sl/1000).toFixed(1)}k`;
  const tp1Text = `TP1 ${(tp1/1000).toFixed(1)}k`;
  const tp2Text = `TP2 ${(tp2/1000).toFixed(1)}k`;

  const r1 = await send('tools/call', { name: 'draw_shape', arguments: { shape: 'rectangle', point: { price: entryHi, time: 1729728000 }, point2: { price: entryLo, time: 1784156400 }, overrides: JSON.stringify({ color: '#00FF88', fillColor: 'rgba(0,255,136,0.15)', text: entryText }) } });
  console.log(ticker, 'ENTRY:', r1.result?.content?.[0]?.text || '?');

  const r2 = await send('tools/call', { name: 'draw_shape', arguments: { shape: 'horizontal_line', point: { price: sl, time: 1729728000 }, overrides: JSON.stringify({ color: '#FF1744', linewidth: 2, text: slText }) } });
  console.log(ticker, 'SL:', r2.result?.content?.[0]?.text || '?');

  const r3 = await send('tools/call', { name: 'draw_shape', arguments: { shape: 'horizontal_line', point: { price: tp1, time: 1729728000 }, overrides: JSON.stringify({ color: '#00E676', linewidth: 2, text: tp1Text }) } });
  console.log(ticker, 'TP1:', r3.result?.content?.[0]?.text || '?');

  const r4 = await send('tools/call', { name: 'draw_shape', arguments: { shape: 'horizontal_line', point: { price: tp2, time: 1729728000 }, overrides: JSON.stringify({ color: '#00E676', linewidth: 1, text: tp2Text }) } });
  console.log(ticker, 'TP2:', r4.result?.content?.[0]?.text || '?');

  child.stdin.end();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(e => { console.error('ERR:', e.message); child.kill(); process.exit(1); });
