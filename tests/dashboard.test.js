import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ActivityMonitor } from '../src/activity.js';
import { TerminalDashboard } from '../src/admin/dashboard.js';

class FakeOutput {
  constructor() {
    this.isTTY = true;
    this.columns = 100;
    this.rows = 28;
    this.output = '';
  }

  write(value) {
    this.output += value;
    return true;
  }
}

class FakeInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
  }

  setRawMode() {}
  resume() {}
  pause() {}
}

describe('live activity dashboard', () => {
  it('clears the terminal before the first interactive render', () => {
    const stdout = new FakeOutput();
    const dashboard = new TerminalDashboard(new ActivityMonitor(), {
      stdout,
      stdin: new FakeInput(),
    });

    dashboard.start();
    dashboard.stop();

    assert.ok(stdout.output.startsWith('\x1b[2J\x1b[H'), 'dashboard must clear the screen first');
  });

  it('renders endpoint, health counters, sessions, tool activity, and CDP status', () => {
    const monitor = new ActivityMonitor();
    monitor.sessionOpened('12345678-session');
    monitor.request('POST', '/mcp');
    const callId = monitor.toolStarted('pine_edit');
    monitor.toolFinished(callId);
    monitor.setTradingView(true, 'BTCUSD chart');

    const stdout = new FakeOutput();
    const dashboard = new TerminalDashboard(monitor, {
      host: '127.0.0.1',
      port: 3333,
      endpoint: '/mcp',
      transport: 'Streamable HTTP',
      stdout,
      stdin: new FakeInput(),
    });
    dashboard.render();

    assert.match(stdout.output, /TradingView MCP - Live Activity/);
    assert.match(stdout.output, /http:\/\/127\.0\.0\.1:3333\/mcp/);
    assert.match(stdout.output, /Sessions 1/);
    assert.match(stdout.output, /Requests 1/);
    assert.match(stdout.output, /Tools 1/);
    assert.match(stdout.output, /CONNECTED/);
    assert.match(stdout.output, /Finished pine_edit/);
  });

  it('erases every terminal row before rewriting request activity', () => {
    const monitor = new ActivityMonitor();
    const stdout = new FakeOutput();
    const dashboard = new TerminalDashboard(monitor, {
      stdout,
      stdin: new FakeInput(),
    });

    monitor.request('POST', '/mcp/a-very-long-request-path-that-will-be-replaced');
    dashboard.render();
    const firstRenderClears = (stdout.output.match(/\x1b\[2K/g) || []).length;

    monitor.request('GET', '/mcp');
    dashboard.render();
    const allRenderClears = (stdout.output.match(/\x1b\[2K/g) || []).length;

    assert.equal(firstRenderClears, stdout.rows - 1, 'first frame clears every rendered row');
    assert.equal(allRenderClears, (stdout.rows - 1) * 2, 'replacement frame clears every row again');
    assert.match(stdout.output, /\x1b\[2K\r.*GET \/mcp/);
  });
});
