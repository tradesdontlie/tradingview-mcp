import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getToolDefinitions } from '../src/tool-definitions.js';
import { allTools, isToolEnabled } from '../src/permissions.js';
import { PROJECT_ROOT, outputPathsToEnv, resolveOutputDirectory } from '../src/output-paths.js';
import { captureScreenshot } from '../src/core/capture.js';

it('retains every upstream public tool name and explicitly classifies every added tool', () => {
  const baseline = JSON.parse(readFileSync(new URL('./upstream_tool_names.json', import.meta.url)));
  const names = getToolDefinitions().map(tool => tool.name);
  for (const name of baseline) assert.ok(names.includes(name), `Missing upstream tool ${name}`);
  assert.deepEqual(allTools().map(tool => tool.name).sort(), [...names].sort());
  for (const removed of ['IHSG_Screen', 'data_save_ohlcv', 'news_get', 'data_get_financials']) assert.ok(!names.includes(removed));
});

it('uses conservative Read classification for existing tools that open UI and preserves offline analysis', () => {
  const cfg = { mode: 'read', enabled: new Set(), disabled: new Set() };
  for (const name of ['pine_get_source', 'pine_get_errors', 'pine_get_console', 'watchlist_get', 'indicator_search', 'capture_screenshot']) assert.equal(isToolEnabled(name, cfg), false, name);
  for (const name of ['pine_analyze', 'pine_check', 'quote_get', 'target_list', 'replay_status']) assert.equal(isToolEnabled(name, cfg), true, name);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.scripts.start, 'node src/server.js');
  assert.equal(pkg.dependencies.exceljs, undefined);
});

it('routes ordinary PNGs to a changed screenshot destination without storing market data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'upstream-shots-'));
  const previous = process.env.MCP_SCREENSHOT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.MCP_SCREENSHOT_DIR; else process.env.MCP_SCREENSHOT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  const _deps = { getClient: async () => ({ Page: { captureScreenshot: async () => ({ data: Buffer.from('png-test').toString('base64') }) } }) };
  process.env.MCP_SCREENSHOT_DIR = join(directory, 'one');
  const one = await captureScreenshot({ filename: 'chart:one', _deps });
  assert.equal(readFileSync(one.file_path, 'utf8'), 'png-test');
  assert.deepEqual(readdirSync(process.env.MCP_SCREENSHOT_DIR), ['chart_one.png']);
  process.env.MCP_SCREENSHOT_DIR = join(directory, 'two');
  const two = await captureScreenshot({ filename: 'second', _deps });
  assert.equal(two.file_path, join(directory, 'two', 'second.png'));
});

it('persists only screenshot configuration and preserves unrelated quoted config verbatim', t => {
  const directory = mkdtempSync(join(tmpdir(), 'upstream-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const permissions = pathToFileURL(join(PROJECT_ROOT, 'src/permissions.js')).href;
  const paths = pathToFileURL(join(PROJECT_ROOT, 'src/output-paths.js')).href;
  const script = `import{writeFileSync,readFileSync}from'node:fs';import{saveEnv,loadEnv}from${JSON.stringify(permissions)};import{outputPathsToEnv}from${JSON.stringify(paths)};const original='# note\\nUNRELATED=" value "\\n';writeFileSync('.env',original);saveEnv(outputPathsToEnv({screenshots:'C:\\\\Screenshots ä # O\\\'Brien'}));const raw=readFileSync('.env','utf8');console.log(JSON.stringify({raw,env:loadEnv()}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: directory, encoding: 'utf8' }));
  assert.ok(result.raw.startsWith('# note\nUNRELATED=" value "\n'));
  assert.equal(result.env.UNRELATED, ' value ');
  assert.equal(result.env.MCP_SCREENSHOT_DIR, "C:\\Screenshots ä # O'Brien");
  assert.deepEqual(Object.keys(outputPathsToEnv({ screenshots: '' })), ['MCP_SCREENSHOT_DIR']);
  assert.equal(existsSync(join(directory, 'screenshots')), false);
  assert.equal(resolveOutputDirectory('screenshots', ''), join(PROJECT_ROOT, 'screenshots'));
});
