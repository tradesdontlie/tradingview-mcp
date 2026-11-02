import { EventEmitter } from 'node:events';

const MAX_EVENTS = 100;

export class ActivityMonitor extends EventEmitter {
  constructor() {
    super();
    this.startedAt = Date.now();
    this.requests = 0;
    this.toolCalls = 0;
    this.errors = 0;
    this.sessions = new Map();
    this.activeTools = new Map();
    this.events = [];
    this.tradingView = { connected: false, detail: 'Checking port 9222...' };
  }

  addEvent(kind, message, level = 'info') {
    const event = { time: new Date(), kind, message, level };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.shift();
    this.emit('change', this.snapshot());
    return event;
  }

  request(method, path) {
    this.requests += 1;
    this.addEvent('http', `${method} ${path}`);
  }

  sessionOpened(id, transport = 'streamable-http') {
    this.sessions.set(id, { id, transport, openedAt: Date.now() });
    this.addEvent('session', `Opened ${shortId(id)} (${transport})`, 'success');
  }

  sessionClosed(id) {
    if (!this.sessions.delete(id)) return;
    this.addEvent('session', `Closed ${shortId(id)}`);
  }

  toolStarted(name) {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.toolCalls += 1;
    this.activeTools.set(id, { id, name, startedAt: Date.now() });
    this.addEvent('tool', `Started ${name}`);
    return id;
  }

  toolFinished(id, error = null) {
    const call = this.activeTools.get(id);
    if (!call) return;
    this.activeTools.delete(id);
    const duration = Date.now() - call.startedAt;
    if (error) {
      this.errors += 1;
      this.addEvent('tool', `Failed ${call.name} after ${duration} ms: ${error.message || error}`, 'error');
    } else {
      this.addEvent('tool', `Finished ${call.name} in ${duration} ms`, 'success');
    }
  }

  failure(message) {
    this.errors += 1;
    this.addEvent('error', message, 'error');
  }

  setTradingView(connected, detail) {
    const changed = this.tradingView.connected !== connected || this.tradingView.detail !== detail;
    this.tradingView = { connected, detail };
    if (changed) this.addEvent('cdp', detail, connected ? 'success' : 'warning');
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      requests: this.requests,
      toolCalls: this.toolCalls,
      errors: this.errors,
      sessions: [...this.sessions.values()],
      activeTools: [...this.activeTools.values()],
      events: [...this.events],
      tradingView: { ...this.tradingView },
    };
  }
}

export function shortId(id) {
  return id ? String(id).slice(0, 8) : '-';
}
