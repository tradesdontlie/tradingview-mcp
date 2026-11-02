import readline from 'node:readline';
import { shortId } from '../activity.js';

const ESC = '\x1b[';
const color = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
  cyan: `${ESC}36m`,
};

function elapsed(startedAt) {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((n) => String(n).padStart(2, '0')).join(':');
}

function crop(value, width) {
  const text = String(value);
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 3))}...`;
}

function eventColor(level) {
  if (level === 'error') return color.red;
  if (level === 'warning') return color.yellow;
  if (level === 'success') return color.green;
  return color.cyan;
}

export class TerminalDashboard {
  constructor(monitor, options = {}) {
    this.monitor = monitor;
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 3333;
    this.endpoint = options.endpoint || '/mcp';
    this.transport = options.transport || 'Streamable HTTP';
    this.onQuit = options.onQuit || (() => {});
    this.stdout = options.stdout || process.stdout;
    this.stdin = options.stdin || process.stdin;
    this.interactive = Boolean(this.stdout.isTTY && this.stdin.isTTY);
    this.timer = null;
    this.renderPending = false;
    this.changeHandler = () => this.scheduleRender();
    this.keyHandler = (_text, key) => {
      if ((key?.ctrl && key.name === 'c') || key?.name === 'q') this.onQuit();
    };
  }

  start() {
    this.monitor.on('change', this.changeHandler);
    if (this.interactive) {
      readline.emitKeypressEvents(this.stdin);
      this.stdin.setRawMode(true);
      this.stdin.resume();
      this.stdin.on('keypress', this.keyHandler);
      this.stdout.write(`${ESC}2J${ESC}H${ESC}?25l`);
      this.timer = setInterval(() => this.render(), 1000);
      this.render();
    } else {
      this.stdout.write(`TradingView MCP listening at http://${this.host}:${this.port}${this.endpoint}\n`);
      this.stdout.write('Live dashboard disabled because this terminal is not interactive.\n');
      this.monitor.on('change', () => {
        const last = this.monitor.events.at(-1);
        if (last) this.stdout.write(`[${last.time.toISOString()}] ${last.kind}: ${last.message}\n`);
      });
    }
  }

  scheduleRender() {
    if (!this.interactive || this.renderPending) return;
    this.renderPending = true;
    setTimeout(() => {
      this.renderPending = false;
      this.render();
    }, 40);
  }

  render() {
    if (!this.interactive) return;
    const state = this.monitor.snapshot();
    // Keep one physical column free. Writing into the final terminal column can
    // trigger an automatic wrap on Windows terminals and leave a ghost line on
    // the next redraw.
    const width = Math.max(69, Math.min((this.stdout.columns || 100) - 1, 119));
    const rows = Math.max(20, this.stdout.rows || 30);
    const rule = '-'.repeat(width);
    const tvColor = state.tradingView.connected ? color.green : color.yellow;
    const lines = [];

    lines.push(`${color.bold}TradingView MCP - Live Activity${color.reset}`);
    lines.push(`${color.dim}${this.transport}${color.reset}  http://${this.host}:${this.port}${this.endpoint}  ${color.dim}q/Ctrl+C: stop${color.reset}`);
    lines.push(rule);
    lines.push(
      `Status ${color.green}RUNNING${color.reset}  ` +
      `Uptime ${elapsed(state.startedAt)}  ` +
      `Sessions ${state.sessions.length}  ` +
      `Requests ${state.requests}  ` +
      `Tools ${state.toolCalls}  ` +
      `Errors ${state.errors}`,
    );
    lines.push(`TradingView ${tvColor}${state.tradingView.connected ? 'CONNECTED' : 'WAITING'}${color.reset}  ${crop(state.tradingView.detail, width - 30)}`);
    lines.push(rule);

    const active = state.activeTools.length
      ? state.activeTools.map((tool) => `${tool.name} (${Date.now() - tool.startedAt} ms)`).join(', ')
      : 'none';
    lines.push(`${color.bold}Active tools:${color.reset} ${crop(active, width - 15)}`);
    const sessions = state.sessions.length
      ? state.sessions.map((session) => `${shortId(session.id)}:${session.transport}`).join(', ')
      : 'none';
    lines.push(`${color.bold}Sessions:${color.reset} ${crop(sessions, width - 11)}`);
    lines.push(rule);
    lines.push(`${color.bold}Recent activity${color.reset}`);

    const available = Math.max(5, rows - lines.length - 2);
    for (const event of state.events.slice(-available)) {
      const timestamp = event.time.toLocaleTimeString('de-DE', { hour12: false });
      const prefix = `${timestamp} ${event.kind.padEnd(8)}`;
      lines.push(`${color.dim}${prefix}${color.reset} ${eventColor(event.level)}${crop(event.message, width - prefix.length - 1)}${color.reset}`);
    }
    while (lines.length < rows - 1) lines.push('');

    // Cursor-home alone is not enough when a replacement line is shorter than
    // its previous content. Erase every physical line before writing it, then
    // clear everything below the frame as a final guard against stale rows.
    const frame = lines
      .slice(0, rows - 1)
      .map((line) => `${ESC}2K\r${line}`)
      .join('\n');
    this.stdout.write(`${ESC}H${frame}${ESC}J`);
  }

  stop() {
    this.monitor.off('change', this.changeHandler);
    if (this.timer) clearInterval(this.timer);
    if (this.interactive) {
      this.stdin.off('keypress', this.keyHandler);
      if (this.stdin.isTTY) this.stdin.setRawMode(false);
      this.stdin.pause();
      this.stdout.write(`${ESC}?25h${color.reset}\n`);
    }
  }
}
