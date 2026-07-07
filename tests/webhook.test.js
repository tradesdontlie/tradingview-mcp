/**
 * Tests for the alert webhook receiver core.
 * Spins a real http server on an ephemeral port — no CDP / TradingView required.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { start, stop, status, list, clear, _resetState } from '../src/core/webhook.js';

const SECRET = 'test-secret-1234567890';

function request(port, { method = 'POST', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('webhook receiver', () => {
  let port;

  before(async () => {
    _resetState();
    const result = await start({ port: 0, secret: SECRET });
    assert.equal(result.success, true);
    port = result.port;
    assert.ok(port > 0, 'should have allocated an ephemeral port');
  });

  after(async () => {
    await stop();
    _resetState();
  });

  beforeEach(() => {
    clear();
  });

  it('rejects start without a secret', async () => {
    await stop();
    _resetState();
    const prev = process.env.TV_WEBHOOK_SECRET;
    delete process.env.TV_WEBHOOK_SECRET;
    await assert.rejects(() => start({ port: 0 }), /secret required/i);
    process.env.TV_WEBHOOK_SECRET = prev;
    // restart for remaining tests
    const r = await start({ port: 0, secret: SECRET });
    port = r.port;
  });

  it('rejects start with too-short secret', async () => {
    await stop();
    await assert.rejects(() => start({ port: 0, secret: 'short' }), /secret required/i);
    const r = await start({ port: 0, secret: SECRET });
    port = r.port;
  });

  it('returns already_running on second start with matching config', async () => {
    const r = await start({ port: 0, secret: SECRET });
    assert.equal(r.already_running, true);
    assert.equal(r.port, port);
  });

  it('errors on second start if config conflicts', async () => {
    await assert.rejects(
      () => start({ port: 0, secret: 'a-different-long-secret' }),
      /already running.*secret/i
    );
    await assert.rejects(
      () => start({ port: 9999, secret: SECRET }),
      /already running.*port/i
    );
    await assert.rejects(
      () => start({ max_alerts: 42, secret: SECRET }),
      /already running.*max_alerts/i
    );
  });

  it('rejects POST without auth header (401)', async () => {
    const r = await request(port, { body: '{"foo":1}', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 401);
    assert.equal(status().total_rejected, 1);
  });

  it('rejects POST with wrong secret (401)', async () => {
    const r = await request(port, {
      body: '{"foo":1}',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 'wrong' },
    });
    assert.equal(r.status, 401);
  });

  it('accepts POST with correct X-Webhook-Secret header', async () => {
    const r = await request(port, {
      body: JSON.stringify({ symbol: 'ES1!', action: 'buy', price: 4500 }),
      headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    });
    assert.equal(r.status, 200);
    const parsed = JSON.parse(r.body);
    assert.equal(parsed.ok, true);
    assert.match(parsed.id, /^[0-9a-f-]{36}$/);

    const alerts = list().alerts;
    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0].body, { symbol: 'ES1!', action: 'buy', price: 4500 });
    assert.equal(alerts[0].parsed, true);
    assert.equal(alerts[0].raw, '{"symbol":"ES1!","action":"buy","price":4500}');
    assert.equal(alerts[0].contentType, 'application/json');
  });

  it('accepts Authorization: Bearer <secret>', async () => {
    const r = await request(port, {
      body: 'plain text alert',
      headers: { authorization: `Bearer ${SECRET}` },
    });
    assert.equal(r.status, 200);
    const alerts = list().alerts;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].body, null);
    assert.equal(alerts[0].parsed, false);
    assert.equal(alerts[0].raw, 'plain text alert');
  });

  it('parsed=false for invalid JSON, raw is preserved', async () => {
    await request(port, {
      body: '{not json',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    });
    const alerts = list().alerts;
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].parsed, false);
    assert.equal(alerts[0].body, null);
    assert.equal(alerts[0].raw, '{not json');
  });

  it('parses JSON body even without content-type', async () => {
    const r = await request(port, {
      body: '{"k":"v"}',
      headers: { 'x-webhook-secret': SECRET },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(list().alerts[0].body, { k: 'v' });
  });

  it('rejects bodies larger than 64 KB (413)', async () => {
    const big = 'x'.repeat(65 * 1024);
    const r = await request(port, {
      body: big,
      headers: { 'content-type': 'text/plain', 'x-webhook-secret': SECRET },
    });
    assert.equal(r.status, 413);
    assert.equal(list().count, 0);
  });

  it('rejects non-POST methods (405)', async () => {
    const r = await request(port, { method: 'PUT', headers: { 'x-webhook-secret': SECRET } });
    assert.equal(r.status, 405);
    assert.equal(r.headers.allow, 'POST');
  });

  it('GET /health responds 200 without auth and without leaking counters', async () => {
    // First, generate some receive activity
    await request(port, {
      body: '{"x":1}',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    });
    const r = await request(port, { method: 'GET', path: '/health' });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    // Should NOT include any counters that leak webhook activity
    assert.equal(body.received, undefined);
    assert.equal(body.total_received, undefined);
    assert.equal(body.count, undefined);
  });

  it('rate-limits per IP and reports 429', async () => {
    await stop();
    await start({ port: 0, secret: SECRET, rate_limit_per_min: 3 });
    const p = status().port;
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(p, {
        body: JSON.stringify({ i }),
        headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
      });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal(status().total_rate_limited, 2);
    // Last successful response should include Retry-After hint on the 429
    const lateRes = await request(p, {
      body: '{}',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    });
    assert.equal(lateRes.status, 429);
    assert.equal(lateRes.headers['retry-after'], '60');

    await stop();
    const restart = await start({ port: 0, secret: SECRET });
    port = restart.port;
  });

  it('rate_limit_per_min: 0 disables rate-limiting', async () => {
    await stop();
    await start({ port: 0, secret: SECRET, rate_limit_per_min: 0 });
    const p = status().port;
    for (let i = 0; i < 20; i++) {
      const r = await request(p, {
        body: '{}',
        headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
      });
      assert.equal(r.status, 200);
    }
    await stop();
    const restart = await start({ port: 0, secret: SECRET });
    port = restart.port;
  });

  it('rate-limits 401s too so auth-fail brute force is bounded', async () => {
    await stop();
    await start({ port: 0, secret: SECRET, rate_limit_per_min: 2 });
    const p = status().port;
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const r = await request(p, {
        body: '{}',
        headers: { 'content-type': 'application/json', 'x-webhook-secret': 'wrong' },
      });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [401, 401, 429, 429]);

    await stop();
    const restart = await start({ port: 0, secret: SECRET });
    port = restart.port;
  });

  it('ring buffer caps at max_alerts', async () => {
    await stop();
    await start({ port: 0, secret: SECRET, max_alerts: 3 });
    const newPort = status().port;
    for (let i = 0; i < 5; i++) {
      await request(newPort, {
        body: JSON.stringify({ i }),
        headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
      });
    }
    const r = list();
    assert.equal(r.count, 3);
    assert.equal(r.total_received, 5);
    assert.deepEqual(r.alerts.map((a) => a.body.i), [2, 3, 4]);

    await stop();
    const restart = await start({ port: 0, secret: SECRET });
    port = restart.port;
  });

  it('list({ limit }) returns the most recent N', async () => {
    for (let i = 0; i < 4; i++) {
      await request(port, {
        body: JSON.stringify({ i }),
        headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
      });
    }
    const r = list({ limit: 2 });
    assert.equal(r.count, 2);
    assert.deepEqual(r.alerts.map((a) => a.body.i), [2, 3]);
  });

  it('list({ since }) filters by receivedAt', async () => {
    await request(port, {
      body: JSON.stringify({ tag: 'before' }),
      headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    });
    await new Promise((r) => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 10));
    await request(port, {
      body: JSON.stringify({ tag: 'after' }),
      headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    });
    const r = list({ since: cutoff });
    assert.equal(r.count, 1);
    assert.equal(r.alerts[0].body.tag, 'after');
  });

  it('clear() empties buffer but preserves counters', async () => {
    await request(port, {
      body: '{"x":1}',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    });
    const beforeCount = status().total_received;
    const result = clear();
    assert.equal(result.cleared, 1);
    assert.equal(list().count, 0);
    assert.equal(status().total_received, beforeCount);
  });

  it('status reports running=false after stop', async () => {
    await stop();
    const s = status();
    assert.equal(s.running, false);
    assert.equal(s.port, null);
    // restart for any subsequent tests
    const r = await start({ port: 0, secret: SECRET });
    port = r.port;
  });

  it('falls back to TV_WEBHOOK_SECRET env var', async () => {
    await stop();
    _resetState();
    process.env.TV_WEBHOOK_SECRET = 'env-secret-1234';
    const r = await start({ port: 0 });
    assert.equal(r.success, true);
    delete process.env.TV_WEBHOOK_SECRET;
    const auth = await request(r.port, {
      body: '{"hi":1}',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 'env-secret-1234' },
    });
    assert.equal(auth.status, 200);
    await stop();
    const restart = await start({ port: 0, secret: SECRET });
    port = restart.port;
  });
});
