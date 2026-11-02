import readline from 'node:readline';
import { allTools, loadConfig, saveEnv, configToEnv, isToolEnabled, setPermissionMode, loadAuditConfig } from '../permissions.js';

import { loadOutputPaths, outputPathsToEnv, resolveOutputDirectory, validateOutputDirectory } from '../output-paths.js';
import { getToolDefinitions } from '../tool-definitions.js';

const ESC = '\x1b[';
const reset = `${ESC}0m`;
const bold = `${ESC}1m`;
const dim = `${ESC}2m`;
const inv = `${ESC}7m`;
const green = `${ESC}32m`;
const red = `${ESC}31m`;
const yellow = `${ESC}33m`;
const cyan = `${ESC}36m`;

export function runTui({ stdin = process.stdin, stdout = process.stdout, onQuit = (code) => process.exit(code), saveSettings = saveEnv } = {}) {
  const cfg = loadConfig();
  let auditEnabled = loadAuditConfig().enabled;
  const definitions = new Map(getToolDefinitions().map(t => [t.name, t]));
  const tools = allTools().map(t => ({ ...t, ...definitions.get(t.name) }));
  const pathSettings = loadOutputPaths();
  const outputPaths = { screenshots: pathSettings.screenshots.configured };
  const pathKinds = ['screenshots'];
  let folders = false;
  let folderCursor = 0;
  let edit = null;
  let paste = null;
  let details = false;
  let detailOffset = 0;
  let cursor = 0;
  let dirty = false;
  let status = '';
  let confirmingQuit = false;



  function effectiveEnabled(name) {
    return isToolEnabled(name, cfg);
  }

  function toggleOne(name) {
    const enabled = effectiveEnabled(name);
    if (cfg.mode === 'custom') {
      if (enabled) {
        cfg.enabled.delete(name);
        cfg.disabled.add(name);
      } else {
        cfg.disabled.delete(name);
        cfg.enabled.add(name);
      }
    } else {
      if (enabled) cfg.disabled.add(name);
      else cfg.disabled.delete(name);
    }
    dirty = true;
  }

  function setMode(mode) {
    setPermissionMode(cfg, mode);
    dirty = true;
  }

  function render() {
    stdout.write(`${ESC}2J${ESC}H`);
    const total = tools.length;
    const on = tools.filter((t) => effectiveEnabled(t.name)).length;
    stdout.write(`${bold}TradingView MCP — Permission Admin${reset}  ${dim}(${on}/${total} enabled)${reset}\n`);
    stdout.write(`Mode: `);
    stdout.write(cfg.mode === 'read' ? `${green}${inv} READ ${reset}` : ` read `);
    stdout.write(' ');
    stdout.write(cfg.mode === 'rw' ? `${green}${inv} RW ${reset}` : ` rw `);
    stdout.write(' ');
    stdout.write(cfg.mode === 'custom' ? `${green}${inv} CUSTOM ${reset}` : ` custom `);
    stdout.write(`   ${dim}[r]ead [w]rw [c]ustom  [l]audit=${auditEnabled ? 'on' : 'off'}  [f]olders  space=toggle  enter=details  s=save  q=quit${reset}\n`);
    stdout.write(`${dim}${'─'.repeat(72)}${reset}\n`);

    const rows = stdout.rows || 30;
    const viewport = Math.max(4, rows - 9);
    if (folders) {
      stdout.write(`${bold}Output folders${reset}\n`);
      for (let i = 0; i < pathKinds.length; i++) {
        const kind = pathKinds[i];
        const label = 'Screenshots';
        const value = edit && i === folderCursor ? edit.text : outputPaths[kind];
        const display = text => String(text).replace(/[\x00-\x1f\x7f]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`);
        stdout.write(`${i === folderCursor ? '>' : ' '} ${label}: ${display(value) || '(default)'}${edit && i === folderCursor ? ' [editing]' : ''}\n`);
        try {
          const override = pathSettings[kind].override;
          stdout.write(`  Effective: ${resolveOutputDirectory(kind, override ?? value)}${override !== undefined ? ' [process environment override]' : ''}\n`);
        } catch (error) { stdout.write(`  Invalid: ${error.message}\n`); }
      }
      stdout.write(`${dim}${edit ? 'Type path | left/right/home/end | backspace/delete | enter accept | escape cancel' : 'up/down select | enter edit | empty path resets default | s save | escape back | q quit'}${reset}\n`);
      if (edit) stdout.write(`Edit: ${edit.text.slice(0, edit.position).replace(/[\x00-\x1f\x7f]/g, '?')}|${edit.text.slice(edit.position).replace(/[\x00-\x1f\x7f]/g, '?')}\n`);
      stdout.write(`${confirmingQuit ? 'Unsaved changes. Press q again to discard, s to save & quit.' : status || (dirty ? 'Modified (not saved)' : 'Saved') }\n`);
      return;
    }
    if (details) {
      const t = tools[cursor];
      const width = Math.max(30, (stdout.columns || 100) - 2);
      const lines = [t.name + ' [' + t.kind + ']', t.description, '', 'Parameters:'];
      for (const [name, schema] of Object.entries(t.parameters || {})) {
        lines.push(name + (schema.isOptional() ? ' (optional)' : ' (required)') + ': ' + (schema.description || ''));
      }
      if (!Object.keys(t.parameters || {}).length) lines.push('(none)');
      const wrapped = lines.flatMap(line => String(line || '').match(new RegExp('.{1,' + width + '}', 'g')) || ['']);
      detailOffset = Math.max(0, Math.min(detailOffset, Math.max(0, wrapped.length - viewport)));
      stdout.write(wrapped.slice(detailOffset, detailOffset + viewport).join('\n') + '\n');
      stdout.write(`${dim}up/down scroll | enter/escape back | space toggle | s save${reset}\n`);
      return;
    }
    const start = Math.max(0, Math.min(cursor - Math.floor(viewport / 2), tools.length - viewport));
    const end = Math.min(tools.length, start + viewport);
    let lastGroup = '';
    for (let i = start; i < end; i++) {
      const t = tools[i];
      const enabled = effectiveEnabled(t.name);
      const mark = enabled ? `${green}[x]${reset}` : `${red}[ ]${reset}`;
      const tag = t.kind === 'read' ? `${cyan}read ${reset}` : `${yellow}write${reset}`;
      const group = t.group !== lastGroup ? t.group.padEnd(11) : ''.padEnd(11);
      lastGroup = t.group;
      const line = `${i === cursor ? '›' : ' '} ${mark} ${tag}  ${group}${t.name}`;
      stdout.write(i === cursor ? `${inv}${line}${reset}\n` : `${line}\n`);
    }
    stdout.write(`${dim}${'─'.repeat(72)}${reset}\n`);
    if (confirmingQuit) {
      stdout.write(`${yellow}Unsaved changes. Press q again to discard, s to save & quit.${reset}\n`);
    } else if (status) {
      stdout.write(`${status}\n`);
    } else {
      stdout.write(`${dim}${dirty ? '● modified' : ' saved'}${reset}\n`);
    }
  }

  function save() {
    try {
      const paths = outputPathsToEnv(outputPaths);
      saveSettings({ ...configToEnv(cfg), MCP_AUDIT_LOG: auditEnabled ? 'true' : 'false', ...paths });
      dirty = false;
      status = `${green}Saved to .env - output folders apply to the next export${reset}`;
      return true;
    } catch (error) {
      status = `${red}Save failed: ${error.message}${reset}`;
      return false;
    }
  }

  function quit(code = 0) {
    stdout.write(`${ESC}?2004l${ESC}?25h`);
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\n');
    onQuit(code);
  }

  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY) stdin.setRawMode(true);
  stdout.write(`${ESC}?2004h${ESC}?25l`);

  stdin.on('keypress', (str, key) => {
    if (!key) return;
    if (paste) {
      if (key.name === 'paste-end') {
        const input = paste.text;
        if (paste.editing && edit) {
          if (paste.overflow || /[\x00-\x1f\x7f]/u.test(input) || edit.text.length + input.length > 4096) status = 'Paste rejected: use a single-line path without control characters';
          else { edit.text = edit.text.slice(0, edit.position) + input + edit.text.slice(edit.position); edit.position += input.length; status = ''; }
        }
        paste = null;
        render();
      } else {
        const piece = str ?? key.sequence ?? '';
        if (paste.text.length + piece.length > 4096) { paste.overflow = true; paste.text = ''; }
        else if (!paste.overflow) paste.text += piece;
      }
      return;
    }
    if (key.name === 'paste-start') { paste = { text: '', editing: Boolean(edit), overflow: false }; return; }
    status = '';
    // Editing consumes all printable keys before any permission/audit/save hotkey.
    if (edit) {
      if (key.ctrl && key.name === 'c') { quit(0); return; }
      if (key.name === 'escape') { edit = null; status = 'Folder edit cancelled'; }
      else if (key.name === 'return') {
        try {
          const kind = pathKinds[folderCursor];
          const value = validateOutputDirectory(edit.text);
          resolveOutputDirectory(kind, value, { checkExisting: true });
          if (value !== outputPaths[kind]) { outputPaths[kind] = value; dirty = true; confirmingQuit = false; }
          edit = null;
          status = 'Folder accepted; press s to save';
        } catch (error) { status = `${red}${error.message}${reset}`; }
      } else if (key.name === 'left') edit.position = Math.max(0, edit.position - 1);
      else if (key.name === 'right') edit.position = Math.min(edit.text.length, edit.position + 1);
      else if (key.name === 'home') edit.position = 0;
      else if (key.name === 'end') edit.position = edit.text.length;
      else if (key.name === 'backspace') {
        if (edit.position) { edit.text = edit.text.slice(0, edit.position - 1) + edit.text.slice(edit.position); edit.position--; }
      } else if (key.name === 'delete') edit.text = edit.text.slice(0, edit.position) + edit.text.slice(edit.position + 1);
      else if (str && !key.ctrl && !key.meta) {
        if (/[\x00-\x1f\x7f]/u.test(str) || edit.text.length + str.length > 4096) status = 'Path input rejected: control character or excessive length';
        else { edit.text = edit.text.slice(0, edit.position) + str + edit.text.slice(edit.position); edit.position += str.length; }
      }
      render();
      return;
    }
    if (folders) {
      if (key.name === 'escape' || key.name === 'f') { folders = false; }
      else if (key.name === 'up') folderCursor = Math.max(0, folderCursor - 1);
      else if (key.name === 'down') folderCursor = Math.min(pathKinds.length - 1, folderCursor + 1);
      else if (key.name === 'return') { const text = outputPaths[pathKinds[folderCursor]]; edit = { text, position: text.length }; }
      else if (key.name === 's') { const saved = save(); if (saved && confirmingQuit) quit(0); }
      else if (key.name === 'q') { if (!dirty || confirmingQuit) quit(0); else confirmingQuit = true; }
      else if (key.ctrl && key.name === 'c') quit(0);
      render();
      return;
    }
    if (key.ctrl && key.name === 'c') quit(0);
    if (key.name === 'return' || (details && key.name === 'escape')) { details = !details; detailOffset = 0; }
    else if (details && ['up', 'down', 'pageup', 'pagedown'].includes(key.name)) {
      detailOffset += ({ up: -1, down: 1, pageup: -10, pagedown: 10 })[key.name];
    }
    else if (key.name === 'up') cursor = Math.max(0, cursor - 1);
    else if (key.name === 'down') cursor = Math.min(tools.length - 1, cursor + 1);
    else if (key.name === 'pageup') cursor = Math.max(0, cursor - 10);
    else if (key.name === 'pagedown') cursor = Math.min(tools.length - 1, cursor + 10);
    else if (key.name === 'home') cursor = 0;
    else if (key.name === 'end') cursor = tools.length - 1;
    else if (str === ' ') toggleOne(tools[cursor].name);
    else if (key.name === 'f') { folders = true; details = false; }
    else if (key.name === 'l') { auditEnabled = !auditEnabled; dirty = true; confirmingQuit = false; }
    else if (key.name === 'r') { setMode('read'); confirmingQuit = false; }
    else if (key.name === 'w') { setMode('rw'); confirmingQuit = false; }
    else if (key.name === 'c') { setMode('custom'); confirmingQuit = false; }
    else if (key.name === 's') {
      const saved = save();
      if (saved && confirmingQuit) quit(0);
    } else if (key.name === 'q' || key.name === 'escape') {
      if (!dirty) quit(0);
      if (confirmingQuit) quit(0);
      confirmingQuit = true;
    }
    render();
  });

  render();
}
