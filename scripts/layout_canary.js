#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { getLayoutSnapshot, layoutIdentityMatches, layoutSwitch } from '../src/core/ui.js';
import { getState } from '../src/core/chart.js';
import { disconnect, reconnect } from '../src/connection.js';

const LAYOUTS = [
  'Analysis - Stock Database',
  'Analysis - Peers',
  'Analysis - Against Index',
];
const SWITCH_TIMEOUT_MS = 20000;
const STEP_TIMEOUT_MS = 25000;
const SCREENSHOT_TIMEOUT_MS = 10000;
const SUITE_TIMEOUT_MS = 180000;

function withDeadline(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function assertState(state, label) {
  if (!state?.success || !state.symbol || !state.resolution) {
    throw new Error(`${label} returned incomplete chart state`);
  }
}

export function assertPostScreenshotSnapshot(name, switched, snapshot) {
  const expected = {
    id: switched.layout_id,
    url_layout_id: switched.url_layout_id,
    name: switched.layout,
  };
  const baseline = switched.observed || {};
  if (!baseline.target_id || snapshot.target_id !== baseline.target_id) {
    throw new Error(`${name} TradingView chart target changed after screenshot`);
  }
  if (!layoutIdentityMatches(expected, snapshot)) {
    throw new Error(`${name} layout identity changed after screenshot`);
  }
  if (snapshot.pane_count !== baseline.pane_count) {
    throw new Error(`${name} pane count changed after screenshot`);
  }
  if (snapshot.pane_signature !== baseline.pane_signature) {
    throw new Error(`${name} pane signature changed after screenshot`);
  }
  if (snapshot.geometry_signature !== baseline.geometry_signature) {
    throw new Error(`${name} pane geometry changed after screenshot`);
  }
  const baselinePanes = (baseline.panes || []).map(pane => [pane.symbol, pane.resolution]);
  const currentPanes = (snapshot.panes || []).map(pane => [pane.symbol, pane.resolution]);
  if (JSON.stringify(currentPanes) !== JSON.stringify(baselinePanes)) {
    throw new Error(`${name} pane symbols or resolutions changed after screenshot`);
  }
  if (!snapshot.chart_api_ready || !snapshot.pane_geometry_valid
      || !snapshot.symbols_valid || !snapshot.resolutions_valid
      || snapshot.invalid_symbol || snapshot.loading
      || snapshot.visible_modal || snapshot.blank_chart) {
    throw new Error(`${name} snapshot was not stable after screenshot`);
  }
}

async function lightweightScreenshotCheck(expectedTargetId) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const client = await withDeadline(
        reconnect('layout_canary_screenshot', { expectedTargetId }),
        STEP_TIMEOUT_MS,
        'lightweight screenshot reconnect',
      );
      const result = await withDeadline(
        client.Page.captureScreenshot({
          format: 'jpeg',
          quality: 25,
          captureBeyondViewport: false,
          fromSurface: true,
        }),
        SCREENSHOT_TIMEOUT_MS,
        'lightweight screenshot',
      );
      const bytes = result?.data ? Buffer.from(result.data, 'base64').length : 0;
      if (bytes < 1000) throw new Error(`lightweight screenshot was empty (${bytes} bytes)`);
      return bytes;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

async function checkLayout(name) {
  const switched = await layoutSwitch({ name, timeout_ms: SWITCH_TIMEOUT_MS });
  if (!switched?.success || !switched.verified) {
    const reason = switched?.reason || 'false_success';
    throw new Error(`${name} failed verification: ${reason}: ${switched?.error || 'layout switch was not verified'}`);
  }
  const expectedTargetId = switched.observed?.target_id;
  if (!expectedTargetId) throw new Error(`${name} verified result did not retain a TradingView chart target`);

  const beforeScreenshot = await withDeadline(getState(), 5000, `${name} state before screenshot`);
  assertState(beforeScreenshot, `${name} state before screenshot`);
  const screenshotBytes = await lightweightScreenshotCheck(expectedTargetId);
  const afterScreenshot = await withDeadline(getState(), 5000, `${name} state after screenshot`);
  assertState(afterScreenshot, `${name} state after screenshot`);
  const postScreenshotSnapshot = await getLayoutSnapshot({ timeout_ms: 5000, expected_target_id: expectedTargetId });

  if (beforeScreenshot.symbol !== afterScreenshot.symbol || beforeScreenshot.resolution !== afterScreenshot.resolution) {
    throw new Error(`${name} chart state changed during screenshot check`);
  }
  assertPostScreenshotSnapshot(name, switched, postScreenshotSnapshot);

  return {
    layout: name,
    verified: true,
    source: switched.source,
    pane_count: postScreenshotSnapshot.pane_count,
    pane_signature: postScreenshotSnapshot.pane_signature,
    geometry_signature: postScreenshotSnapshot.geometry_signature,
    screenshot_bytes: screenshotBytes,
    state_stable: true,
  };
}

async function main() {
  const suiteTimer = setTimeout(() => {
    console.error(JSON.stringify({ success: false, reason: 'navigation_timeout', error: `Layout canary exceeded ${SUITE_TIMEOUT_MS}ms` }));
    process.exit(1);
  }, SUITE_TIMEOUT_MS);

  try {
    const checks = [];
    for (const name of LAYOUTS) checks.push(await checkLayout(name));
    console.log(JSON.stringify({ success: true, layout_count: checks.length, checks }, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      success: false,
      reason: err.reason || (/timed out/i.test(err.message) ? 'navigation_timeout' : 'canary_failed'),
      error: err.message,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    clearTimeout(suiteTimer);
    await disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
