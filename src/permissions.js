import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAuditLogger } from './audit-log.js';
import { createSessionContext, runWithSessionContext } from './session-context.js';

const ENV_PATH = resolve(process.cwd(), '.env');

export const TOOL_CATALOG = {
  "targets": {
    "read": [
      "target_list"
    ],
    "write": [
      "target_select"
    ]
  },
  "data": {
    "read": [
      "data_get_ohlcv",
      "data_get_indicator",
      "data_get_strategy_results",
      "data_get_trades",
      "data_get_equity",
      "quote_get",
      "depth_get",
      "data_get_pine_lines",
      "data_get_pine_labels",
      "data_get_pine_tables",
      "data_get_pine_boxes",
      "data_get_study_values"
    ],
    "write": [
      "data_load_history",
      "strategy_prepare"
    ]
  },
  "indicators": {
    "read": [
      "indicator_get_style"
    ],
    "write": [
      "indicator_set_style",
      "indicator_set_inputs",
      "indicator_toggle_visibility",
      "indicator_search",
      "indicator_add"
    ]
  },
  "watchlist": {
    "read": [
      "watchlist_get_sections"
    ],
    "write": [
      "watchlist_create_section",
      "watchlist_move_to_section",
      "watchlist_get",
      "watchlist_add",
      "watchlist_add_bulk",
      "watchlist_remove"
    ]
  },
  "health": {
    "read": [
      "tv_health_check",
      "tv_discover",
      "tv_ui_state"
    ],
    "write": [
      "tv_launch",
      "tv_update"
    ]
  },
  "chart": {
    "read": [
      "chart_get_state",
      "chart_get_visible_range",
      "symbol_info",
      "symbol_search"
    ],
    "write": [
      "chart_set_symbol",
      "chart_set_timeframe",
      "chart_set_type",
      "chart_manage_indicator",
      "chart_set_visible_range",
      "chart_scroll_to_date"
    ]
  },
  "pine": {
    "read": [
      "pine_list_scripts",
      "pine_analyze",
      "pine_check"
    ],
    "write": [
      "pine_get_source",
      "pine_set_source",
      "pine_compile",
      "pine_get_errors",
      "pine_save",
      "pine_get_console",
      "pine_smart_compile",
      "pine_new",
      "pine_open"
    ]
  },
  "capture": {
    "read": [],
    "write": ["capture_screenshot"]
  },
  "drawing": {
    "read": [
      "draw_list",
      "draw_get_properties"
    ],
    "write": [
      "draw_shape",
      "draw_clear",
      "draw_remove_one"
    ]
  },
  "alerts": {
    "read": [
      "alert_list"
    ],
    "write": [
      "alert_create",
      "alert_delete"
    ]
  },
  "batch": {
    "read": [],
    "write": [
      "batch_run"
    ]
  },
  "replay": {
    "read": [
      "replay_status"
    ],
    "write": [
      "replay_start",
      "replay_step",
      "replay_autoplay",
      "replay_stop",
      "replay_trade"
    ]
  },
  "ui": {
    "read": [
      "ui_find_element"
    ],
    "write": [
      "ui_click",
      "ui_open_panel",
      "ui_fullscreen",
      "ui_keyboard",
      "ui_type_text",
      "ui_hover",
      "ui_scroll",
      "ui_mouse_click",
      "ui_evaluate"
    ]
  },
  "layout": {
    "read": [
      "layout_list"
    ],
    "write": [
      "layout_switch",
      "layout_new"
    ]
  },
  "pane": {
    "read": [
      "pane_list"
    ],
    "write": [
      "pane_set_layout",
      "pane_focus",
      "pane_set_symbol"
    ]
  },
  "tab": {
    "read": [
      "tab_list"
    ],
    "write": [
      "tab_new",
      "tab_close",
      "tab_switch"
    ]
  }
};

export function allTools() {
  const out = [];
  for (const [group, kinds] of Object.entries(TOOL_CATALOG)) {
    for (const name of kinds.read) out.push({ name, group, kind: 'read' });
    for (const name of kinds.write) out.push({ name, group, kind: 'write' });
  }
  return out;
}

export function toolKind(name) {
  for (const kinds of Object.values(TOOL_CATALOG)) {
    if (kinds.read.includes(name)) return 'read';
    if (kinds.write.includes(name)) return 'write';
  }
  return 'write';
}

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  return parseEnv(readFileSync(ENV_PATH, 'utf8'));
}

export function loadConfig() {
  const env = { ...loadEnv(), ...process.env };
  const mode = (env.MCP_PERM_MODE || 'rw').toLowerCase();
  const split = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    mode: ['read', 'rw', 'custom'].includes(mode) ? mode : 'rw',
    disabled: new Set(split(env.MCP_PERM_DISABLED)),
    enabled: new Set(split(env.MCP_PERM_ENABLED)),
  };
}

export function isToolEnabled(name, cfg) {
  if (!allTools().some(t => t.name === name)) return false;
  if (cfg.mode === 'read') {
    if (toolKind(name) !== 'read') return false;
    return !cfg.disabled.has(name);
  }
  if (cfg.mode === 'rw') {
    return !cfg.disabled.has(name);
  }
  return cfg.enabled.has(name) && !cfg.disabled.has(name);
}

export function loadAuditConfig() {
  const env = { ...loadEnv(), ...process.env };
  return {
    enabled: /^(1|true)$/i.test(env.MCP_AUDIT_LOG || ''),
    filePath: env.MCP_AUDIT_LOG_PATH || '.local/audit/tool-calls.jsonl',
    maxBytes: Number(env.MCP_AUDIT_MAX_BYTES || 1048576),
    maxFiles: Number(env.MCP_AUDIT_MAX_FILES || 3),
  };
}

let auditCache;
export function getAuditLogger() {
  const config = loadAuditConfig();
  const key = JSON.stringify(config);
  if (!auditCache || auditCache.key !== key) {
    auditCache = { key, logger: createAuditLogger({ ...config, toolNames: allTools().map(t => t.name) }) };
  }
  return auditCache.logger;
}

function failedToolResult(result) {
  if (result?.isError || result?.success === false) return true;
  const text = result?.content?.find(c => c.type === 'text')?.text;
  if (typeof text === 'string' && text.length <= 1048576) {
    try { return JSON.parse(text)?.success === false; } catch { /* non-JSON tool output */ }
  }
  return false;
}

export function applyPermissions(server, cfg, activity = null, options = {}) {
  const session = options.session || createSessionContext();
  const audit = options.getAuditLogger || getAuditLogger;
  const original = server.tool.bind(server);
  const skipped = [];
  server.tool = (name, ...rest) => {
    if (!allTools().some(t => t.name === name)) throw new Error(`Tool missing from permission catalog: ${name}`);
    if (!isToolEnabled(name, cfg)) {
      skipped.push(name);
      return { remove: () => {}, update: () => {}, enable: () => {}, disable: () => {} };
    }
    const callbackIndex = rest.findLastIndex(value => typeof value === 'function');
    if (callbackIndex >= 0) {
      const callback = rest[callbackIndex];
      rest[callbackIndex] = (...args) => runWithSessionContext(session, async () => {
        // Recheck after queueing: a permission may have been revoked while another call ran.
        const logger = audit();
        if (!isToolEnabled(name, loadConfig())) {
          logger.record({ tool: name, status: 'denied', duration_ms: 0, targetId: session.selectedTargetId });
          return { isError: true, content: [{ type: 'text', text: `Permission denied: ${name}` }] };
        }
        const token = logger.callStarted(name, { targetId: session.selectedTargetId });
        const callId = activity?.toolStarted(name);
        try {
          const result = await callback(...args);
          const failed = failedToolResult(result);
          activity?.toolFinished(callId, failed ? new Error('Tool returned an error result') : null);
          logger.callFinished(token, { status: failed ? 'error' : 'success' });
          return result;
        } catch (error) {
          activity?.toolFinished(callId, error);
          logger.callFinished(token, { status: 'threw' });
          throw error;
        }
      });
    }
    return original(name, ...rest);
  };
  return { skipped, session };
}

export function saveEnv(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n\x00]/.test(value)) {
      throw new Error('Configuration updates require valid keys and single-line text values');
    }
  }
  const exists = existsSync(ENV_PATH);
  const raw = exists ? readFileSync(ENV_PATH, 'utf8') : '';
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set();
  let output = raw.replace(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[^\r\n]*/gm, (line, key) => {
    if (!Object.hasOwn(updates, key)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    if (output && !output.endsWith('\n')) output += newline;
    output += `${key}=${value}${newline}`;
  }
  const temporary = `${ENV_PATH}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, output, { flag: 'wx', mode: exists ? statSync(ENV_PATH).mode & 0o777 : 0o600 });
    renameSync(temporary, ENV_PATH);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the original write error. */ }
    throw error;
  }
}

export function configToEnv(cfg) {
  return {
    MCP_PERM_MODE: cfg.mode,
    MCP_PERM_DISABLED: [...cfg.disabled].join(','),
    MCP_PERM_ENABLED: [...cfg.enabled].join(','),
  };
}

// Preserve the effective selection when entering Custom; never grant extra tools.
export function setPermissionMode(cfg, mode) {
  if (!['read', 'rw', 'custom'].includes(mode)) throw new Error('Invalid permission mode');
  const selected = allTools().filter(t => isToolEnabled(t.name, cfg)).map(t => t.name);
  cfg.mode = mode;
  if (mode === 'custom') {
    cfg.enabled = new Set(selected);
    cfg.disabled = new Set();
  }
}
