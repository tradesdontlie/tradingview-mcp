const { spawn } = require('child_process');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
const child = spawn('node', [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: path.dirname(serverPath)
});

let output = '';
let id = 1;

child.stdout.on('data', (data) => {
  output += data.toString();
  // Check if we got complete JSON responses
  try {
    const lines = output.trim().split('\n');
    for (const line of lines) {
      if (line.startsWith('{')) {
        const parsed = JSON.parse(line);
        console.log(`[${parsed.id}] ${JSON.stringify(parsed.result || parsed.error)}`);
      }
    }
    output = '';
  } catch(e) { /* accumulate */ }
});

child.stderr.on('data', (data) => {
  // filter out startup warnings
  const text = data.toString();
  if (!text.includes('⚠') && !text.includes('tradingview-mcp')) {
    process.stderr.write(text);
  }
});

function send(method, params) {
  const req = JSON.stringify({
    jsonrpc: '2.0',
    id: id++,
    method: 'tools/call',
    params: { name: method, arguments: params }
  }) + '\n';
  child.stdin.write(req);
}

// Initialize - send initialize request
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'draw', version: '1.0' } }
}) + '\n');

setTimeout(() => {
  // Draw GMD entry zone
  send('draw_shape', {
    shape: 'rectangle',
    point: { price: 79200, time: 1781485200 },
    point2: { price: 79000, time: 1784156400 },
    overrides: '{"color":"#00FF88","fillColor":"rgba(0,255,136,0.15)","text":"ENTRY 79.0-79.2k"}'
  });

  send('draw_shape', {
    shape: 'horizontal_line',
    point: { price: 77800, time: 1781485200 },
    overrides: '{"color":"#FF1744","width":2,"text":"SL 77.8k"}'
  });

  send('draw_shape', {
    shape: 'horizontal_line', 
    point: { price: 81342, time: 1781485200 },
    overrides: '{"color":"#00E676","width":2,"text":"TP1 81.3k"}'
  });

  send('draw_shape', {
    shape: 'horizontal_line',
    point: { price: 83175, time: 1781485200 },
    overrides: '{"color":"#00E676","width":1,"style":2,"text":"TP2 83.2k"}'
  });

  setTimeout(() => {
    child.stdin.end();
    setTimeout(() => process.exit(0), 2000);
  }, 15000);
  
}, 2000);

setTimeout(() => {
  console.log('TIMEOUT - no response received');
  child.kill();
  process.exit(1);
}, 30000);
