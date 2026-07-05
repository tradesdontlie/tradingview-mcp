/**
 * live-test-alert-rest.mjs — LIVE end-to-end test of the REST alert tools
 * (alert_create_webhook / alert_modify_price / alert_delete_one core logic).
 *
 * Requires TradingView Desktop running with CDP on :9222.
 * Creates a throwaway BATS:F alert, modifies its price, deletes it.
 * NEVER touches existing alerts. Run:  node scripts/live-test-alert-rest.mjs
 * Pass --clipboard to also test message_from_clipboard (put text on the
 * clipboard first).
 */
import { createWebhook, modifyPrice, deleteOne, list } from '../src/core/alerts.js';
import { disconnect } from '../src/connection.js';

const useClipboard = process.argv.includes('--clipboard');

function fail(step, detail) {
  console.error(`FAIL at ${step}: ${JSON.stringify(detail)}`);
  process.exitCode = 1;
}

try {
  const before = await list();
  console.log(`alerts before: ${before.alert_count}`);

  // 1) create
  const created = await createWebhook({
    symbol: 'BATS:F',
    price: 1.0,
    ...(useClipboard ? { message_from_clipboard: true } : { message: 'MCP-PATCH-LIVE-TEST — safe to delete' }),
    webhook_url: null,
    popup: false,
  });
  console.log('create:', JSON.stringify(created));
  if (!created.success || created.alert.trigger_value !== 1) { fail('create', created); throw new Error('abort'); }
  const id1 = created.alert.alert_id;

  // 2) modify price (recreate+delete; id changes)
  const modified = await modifyPrice({ alert_id: id1, price: 1.25 });
  console.log('modify:', JSON.stringify(modified));
  if (!modified.success || modified.alert.trigger_value !== 1.25 || !modified.old_deleted) { fail('modify', modified); }
  const id2 = modified.success ? modified.alert.alert_id : id1;

  // 3) delete
  const deleted = await deleteOne({ alert_id: id2 });
  console.log('delete:', JSON.stringify(deleted));
  if (!deleted.success || deleted.verified_gone !== true) { fail('delete', deleted); }

  const after = await list();
  console.log(`alerts after: ${after.alert_count} (must equal before: ${before.alert_count})`);
  if (after.alert_count !== before.alert_count) { fail('leftover-check', { before: before.alert_count, after: after.alert_count }); }

  if (process.exitCode !== 1) console.log('ALL LIVE TESTS PASSED');
} finally {
  await disconnect();
}
