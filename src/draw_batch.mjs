import { spawn } from 'child_process';
import { createInterface } from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, 'server.js');

const child = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname,
});

let id = 0;
const pending = new Map();
const rl = createInterface({ input: child.stdout });

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined) {
      const resolve = pending.get(msg.id);
      if (resolve) {
        resolve(msg);
        pending.delete(msg.id);
      }
    }
  } catch(e) {
    // skip non-JSON lines (warnings)
  }
});

child.stderr.on('data', (d) => {
  const t = d.toString();
  if (!t.includes('⚠') && !t.includes('tradingview-mcp')) process.stderr.write(t);
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const reqId = ++id;
    const req = JSON.stringify({
      jsonrpc: '2.0',
      id: reqId,
      method,
      params,
    }) + '\n';
    pending.set(reqId, resolve);
    child.stdin.write(req);
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        reject(new Error(`Timeout for request ${reqId}`));
      }
    }, 20000);
  });
}

async function main() {
  // Step 1: Initialize
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'draw_batch', version: '1.0' }
  });
  console.log('✓ Initialized');
  
  // Wait for CDP connection
  await new Promise(r => setTimeout(r, 3000));
  
  // Draw rectangle entry zone
  const r1 = await send('tools/call', {
    name: 'draw_shape',
    arguments: {
      shape: 'rectangle',
      point: { price: 79200, time: 1729728000 },
      point2: { price: 79000, time: 1784156400 },
      overrides: '{"color":"#00FF88","fillColor":"rgba(0,255,136,0.15)","text":"ENTRY 79.0-79.2k"}'
    }
  });
  console.log('✓ Entry zone:', r1.result?.content?.[0]?.text || '?');
  
  // SL
  const r2 = await send('tools/call', {
    name: 'draw_shape',
    arguments: {
      shape: 'horizontal_line',
      point: { price: 77800, time: 1729728000 },
      overrides: '{"color":"#FF1744","linewidth":2,"text":"SL 77.8k"}'
    }
  });
  console.log('✓ SL:', r2.result?.content?.[0]?.text || '?');
  
  // TP1
  const r3 = await send('tools/call', {
    name: 'draw_shape',
    arguments: {
      shape: 'horizontal_line',
      point: { price: 81342, time: 1729728000 },
      overrides: '{"color":"#00E676","linewidth":2,"text":"TP1 81.3k"}'
    }
  });
  console.log('✓ TP1:', r3.result?.content?.[0]?.text || '?');
  
  // TP2
  const r4 = await send('tools/call', {
    name: 'draw_shape',
    arguments: {
      shape: 'horizontal_line',
      point: { price: 83175, time: 1729728000 },
      overrides: '{"color":"#00E676","linewidth":1,"text":"TP2 83.2k"}'
    }
  });
  console.log('✓ TP2:', r4.result?.content?.[0]?.text || '?');
  
  // Done
  child.stdin.end();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(e => {
  console.error('ERROR:', e.message);
  child.kill();
  process.exit(1);
});
