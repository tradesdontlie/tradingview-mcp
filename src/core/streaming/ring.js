// Ring buffer — bounded deque per subscription. Hot tier for live tick reads.
// Cold persistence (DuckDB) deferred — append() emits an event you can hook
// from a background flusher.

const DEFAULT_CAP = 1000;

export class RingBuffer {
  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
    this.data = [];
  }
  push(tick) {
    this.data.push(tick);
    if (this.data.length > this.cap) this.data.splice(0, this.data.length - this.cap);
  }
  latest() {
    return this.data.length ? this.data[this.data.length - 1] : null;
  }
  recent(n = 10) {
    return this.data.slice(-Math.max(1, n));
  }
  size() {
    return this.data.length;
  }
  clear() {
    this.data = [];
  }
}
