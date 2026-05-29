// HMAC signing sanity — offline. Verifies Node crypto HMAC matches the
// canonical SHA256 hex format the broker clients use, and that the
// Delta India query-string handling (leading '?' stripped) matches spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

test('HMAC-SHA256 reference vector', () => {
  // Known answer: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog")
  const got = sign('key', 'The quick brown fox jumps over the lazy dog');
  assert.equal(got, 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
});

test('Delta India payload omits leading ? from query string', () => {
  const url = new URL('/v2/orders/history?state=open&page_size=50', 'https://api.india.delta.exchange');
  const queryString = url.search ? url.search.slice(1) : '';
  assert.equal(queryString, 'state=open&page_size=50');
  const payload = 'GET' + '1700000000' + url.pathname + queryString + '';
  assert.ok(!payload.includes('?'));
});

test('Delta India empty query produces empty queryString', () => {
  const url = new URL('/v2/wallet/balances', 'https://api.india.delta.exchange');
  const queryString = url.search ? url.search.slice(1) : '';
  assert.equal(queryString, '');
});

test('CoinDCX payload is JSON string with timestamp', () => {
  const body = { timestamp: 1700000000000, limit: 50 };
  const payload = JSON.stringify(body);
  const sig = sign('secret', payload);
  assert.equal(sig.length, 64); // 32 bytes hex
});
