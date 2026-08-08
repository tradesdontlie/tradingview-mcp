#!/usr/bin/env node
// Read-only discovery probe for TradingView's native Paper Trading runtime.
//
// Run with TradingView Desktop open (CDP on port 9222), ideally with the
// Trading Panel visible and Paper Trading connected:
//
//   node scripts/paper_discovery.js > paper-discovery-results.json
//
// The probe reports ONLY structural knowledge: property names, method names,
// data-name / aria-label attributes, element presence and booleans. Runtime
// objects are inspected through property descriptors, so accessor getters are
// never invoked. It never reads cookies, web storage, or request headers, and
// the printed report redacts secret-looking keys, token-like strings and
// email addresses.
//
// See docs/PAPER_TRADING_DISCOVERY.md for the full manual procedure and the
// evidence tables this report feeds into.
import { pathToFileURL } from 'url';
import { evaluate, disconnect, getTargetInfo, CDP_HOST, CDP_PORT } from '../src/connection.js';

// --- Injected probes (each is a self-contained read-only IIFE) ---

// Shared by the runtime probes below (interpolated into each IIFE).
// Inspection goes through Object.getOwnPropertyDescriptor so that accessor
// getters are never executed, and walks the prototype chain so that
// non-enumerable class methods are not missed.
// Exported for unit tests.
export const MEMBER_INSPECTION_HELPERS = `
  function safeDescriptor(obj, name) {
    try { return Object.getOwnPropertyDescriptor(obj, name); } catch (e) { return null; }
  }
  function ownDataValue(obj, name) {
    var desc = safeDescriptor(obj, name);
    return desc && 'value' in desc ? desc.value : undefined;
  }
  function chainDataValue(obj, name) {
    var current = obj;
    for (var depth = 0; current && depth < 5; depth++) {
      var desc = safeDescriptor(current, name);
      if (desc) return 'value' in desc ? desc.value : undefined;
      current = Object.getPrototypeOf(current);
    }
    return undefined;
  }
  function describeMembers(obj) {
    var seen = {};
    var members = { methods: [], accessors: [], objects: [] };
    var current = obj;
    for (var depth = 0; current && current !== Object.prototype && depth < 5; depth++) {
      var keys = Object.getOwnPropertyNames(current);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key === 'constructor' || seen[key]) continue;
        seen[key] = true;
        var desc = safeDescriptor(current, key);
        if (!desc) continue;
        if (desc.get || desc.set) members.accessors.push(key);
        else if (typeof desc.value === 'function') members.methods.push(key);
        else if (desc.value && typeof desc.value === 'object') members.objects.push(key);
      }
      current = Object.getPrototypeOf(current);
    }
    return members;
  }
`;

// Which globals exist, and which window keys hint at a trading domain.
const NAMESPACE_PROBE = `
(function () {
  ${MEMBER_INSPECTION_HELPERS}
  function describeProperty(obj, name) {
    var desc = safeDescriptor(obj, name);
    if (!desc) return 'unreadable';
    if (desc.get || desc.set) return 'accessor';
    return typeof desc.value;
  }
  function describeKeys(obj) {
    var out = [];
    if (!obj) return out;
    var keys = Object.getOwnPropertyNames(obj);
    for (var i = 0; i < keys.length; i++) {
      out.push({ name: keys[i], type: describeProperty(obj, keys[i]) });
    }
    return out;
  }
  var tradingLike = /trad|brok|order|account|paper|execut/i;
  var windowMatches = [];
  var winKeys = Object.getOwnPropertyNames(window);
  for (var i = 0; i < winKeys.length; i++) {
    if (!tradingLike.test(winKeys[i])) continue;
    windowMatches.push({ name: winKeys[i], type: describeProperty(window, winKeys[i]) });
  }
  return {
    tradingViewApiKeys: describeKeys(window.TradingViewApi),
    tradingViewKeys: describeKeys(window.TradingView),
    windowKeysMatchingTradingTerms: windowMatches,
  };
})()
`;

// Which members of the known namespaces expose trading-like methods.
const SERVICE_SCAN_PROBE = `
(function () {
  ${MEMBER_INSPECTION_HELPERS}
  var tradingMethod = /order|position|account|broker|execut|trade|margin|leverage|commission|balance|equity|bracket|stop|profit/i;
  var tradingKey = /trad|brok|order|account|paper|execut/i;
  function tradingLike(names) {
    return names.filter(function (n) { return tradingMethod.test(n); });
  }
  function describeService(path, value) {
    var members = describeMembers(value);
    var methodMatches = tradingLike(members.methods);
    var accessorMatches = tradingLike(members.accessors);
    if (methodMatches.length === 0 && accessorMatches.length === 0) return null;
    return {
      path: path,
      methodCount: members.methods.length,
      tradingLikeMethods: methodMatches.slice(0, 40),
      tradingLikeAccessors: accessorMatches.slice(0, 20),
      allMethods: members.methods.slice(0, 80),
    };
  }
  function scanNamespace(nsName, ns, findings) {
    if (!ns) return;
    var keys = Object.getOwnPropertyNames(ns);
    for (var i = 0; i < keys.length; i++) {
      var value = ownDataValue(ns, keys[i]);
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
      var found = describeService(nsName + '.' + keys[i], value);
      if (found) findings.push(found);
      // One level deeper, but only under trading-suggestive names, to keep the scan bounded.
      if (typeof value === 'object' && tradingKey.test(keys[i])) {
        var subKeys = Object.getOwnPropertyNames(value);
        for (var j = 0; j < subKeys.length; j++) {
          var sub = ownDataValue(value, subKeys[j]);
          if (!sub || typeof sub !== 'object') continue;
          var subFound = describeService(nsName + '.' + keys[i] + '.' + subKeys[j], sub);
          if (subFound) findings.push(subFound);
        }
      }
    }
  }
  var findings = [];
  scanNamespace('window.TradingViewApi', window.TradingViewApi, findings);
  scanNamespace('window.TradingView', window.TradingView, findings);
  return { services: findings.slice(0, 40) };
})()
`;

// Does the bottom widget bar know about a trading widget?
const BOTTOM_WIDGET_BAR_PROBE = `
(function () {
  ${MEMBER_INSPECTION_HELPERS}
  var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
  if (!bwb) return { available: false };
  var members = describeMembers(bwb);
  var objectMembers = [];
  var objectNames = members.objects.slice(0, 10);
  for (var i = 0; i < objectNames.length; i++) {
    var value = chainDataValue(bwb, objectNames[i]);
    if (value) objectMembers.push({ name: objectNames[i], keys: Object.getOwnPropertyNames(value).slice(0, 30) });
  }
  return {
    available: true,
    methods: members.methods,
    accessors: members.accessors.slice(0, 20),
    objectMembers: objectMembers,
  };
})()
`;

// What the Trading Panel button and panel areas currently expose in the DOM.
// Free-form element text is never collected: only aria-label / data-name /
// role attribute values, which are semantic identifiers rather than user data
// (any email that still slips into a label is redacted by the sanitizer).
const TRADING_PANEL_DOM_PROBE = `
(function () {
  function attrInventory(root, attr, cap) {
    var seen = {};
    var out = [];
    if (!root) return out;
    var nodes = root.querySelectorAll('[' + attr + ']');
    for (var i = 0; i < nodes.length && out.length < cap; i++) {
      var value = nodes[i].getAttribute(attr);
      if (value && !seen[value]) { seen[value] = true; out.push(value); }
    }
    return out;
  }
  function visibleButtonAriaLabels(root, cap) {
    var out = [];
    if (!root) return out;
    var btns = root.querySelectorAll('button[aria-label]');
    for (var i = 0; i < btns.length && out.length < cap; i++) {
      if (btns[i].offsetParent === null) continue;
      var label = btns[i].getAttribute('aria-label').trim();
      if (label && label.length <= 60) out.push(label);
    }
    return out;
  }
  var tradingButton = document.querySelector('[data-name="trading-button"]')
    || document.querySelector('[aria-label="Trading Panel"]');
  var bottomArea = document.querySelector('[class*="layout__area--bottom"]');
  var rightArea = document.querySelector('[class*="layout__area--right"]');
  var bottomText = bottomArea ? bottomArea.textContent : '';
  return {
    tradingButton: tradingButton ? {
      found: true,
      dataName: tradingButton.getAttribute('data-name'),
      ariaLabel: tradingButton.getAttribute('aria-label'),
      ariaPressed: tradingButton.getAttribute('aria-pressed'),
    } : { found: false },
    bottomArea: {
      present: !!bottomArea,
      height: bottomArea ? bottomArea.offsetHeight : 0,
      dataNames: attrInventory(bottomArea, 'data-name', 100),
      roles: attrInventory(bottomArea, 'role', 30),
      buttonAriaLabels: visibleButtonAriaLabels(bottomArea, 60),
      mentionsPaperTrading: /paper trading/i.test(bottomText),
    },
    rightArea: {
      present: !!rightArea,
      width: rightArea ? rightArea.offsetWidth : 0,
      dataNames: attrInventory(rightArea, 'data-name', 60),
    },
  };
})()
`;

// --- Output sanitization (keeps the report safe to share and to commit) ---

const SECRET_KEY_PATTERN = /token|cookie|secret|password|auth|session/i;
const TOKEN_LIKE_VALUE = /^[A-Za-z0-9+/=_-]{40,}$/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAX_STRING_LENGTH = 200;

export function sanitizeForReport(value) {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeForReport);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, member] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeForReport(member);
    }
    return out;
  }
  return value;
}

function sanitizeString(str) {
  if (TOKEN_LIKE_VALUE.test(str)) return '[REDACTED-TOKEN-LIKE]';
  const redacted = str.replace(EMAIL_PATTERN, '[REDACTED-EMAIL]');
  if (redacted.length > MAX_STRING_LENGTH) return redacted.slice(0, MAX_STRING_LENGTH) + '…';
  return redacted;
}

// --- Probe execution ---

async function runProbe(expression) {
  try {
    return await evaluate(expression);
  } catch (err) {
    return { error: err.message };
  }
}

async function collectMeta() {
  const target = await getTargetInfo();
  const url = target?.url ? new URL(target.url) : null;
  return {
    generated_at: new Date().toISOString(),
    cdp_endpoint: `${CDP_HOST}:${CDP_PORT}`,
    target_url: url ? `${url.origin}${url.pathname}` : null,
    user_agent: await runProbe('navigator.userAgent'),
  };
}

async function main() {
  const report = {
    meta: await collectMeta(),
    namespaces: await runProbe(NAMESPACE_PROBE),
    trading_like_services: await runProbe(SERVICE_SCAN_PROBE),
    bottom_widget_bar: await runProbe(BOTTOM_WIDGET_BAR_PROBE),
    trading_panel_dom: await runProbe(TRADING_PANEL_DOM_PROBE),
  };
  process.stdout.write(JSON.stringify(sanitizeForReport(report), null, 2) + '\n');
  await disconnect();
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(async (err) => {
    console.error(`paper_discovery failed: ${err.message}`);
    await disconnect();
    process.exit(1);
  });
}
