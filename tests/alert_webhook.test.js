import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/core/alerts.js';

test('alert_set_webhook refuses without an https TV_ALERT_WEBHOOK_URL (no TradingView call)', async () => {
  const saved = process.env.TV_ALERT_WEBHOOK_URL;
  try {
    delete process.env.TV_ALERT_WEBHOOK_URL;
    let r = await core.setWebhook({ alert_id: 1 });
    assert.equal(r.success, false);
    assert.match(r.error, /TV_ALERT_WEBHOOK_URL/);
    process.env.TV_ALERT_WEBHOOK_URL = 'http://example.com/hook';
    r = await core.setWebhook({ alert_id: 1 });
    assert.equal(r.success, false);
    assert.match(r.error, /https/);
  } finally {
    if (saved === undefined) delete process.env.TV_ALERT_WEBHOOK_URL; else process.env.TV_ALERT_WEBHOOK_URL = saved;
  }
});

test('alert_set_webhook validates alert_id before anything else', async () => {
  process.env.TV_ALERT_WEBHOOK_URL = 'https://example.com/hook';
  for (const bad of [0, -3, 1.5, 'abc', undefined]) {
    const r = await core.setWebhook({ alert_id: bad });
    assert.equal(r.success, false);
    assert.match(r.error, /positive integer/);
  }
  delete process.env.TV_ALERT_WEBHOOK_URL;
});
