import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readmePath = join(__dirname, '..', 'README.md');

function getSection(content, heading) {
  const start = content.indexOf(heading);
  assert.notEqual(start, -1, `Missing heading: ${heading}`);

  const nextTopLevel = content.indexOf('\n## ', start + heading.length);
  return content.slice(start, nextTopLevel === -1 ? undefined : nextTopLevel);
}

test('README documents the Codex CLI entrypoint within the CLI section', () => {
  const content = readFileSync(readmePath, 'utf8');
  const cliSection = getSection(content, '## CLI');

  assert.match(cliSection, /### Codex/);
  assert.match(cliSection, /Use Codex through the repository-local wrapper/);
  assert.match(cliSection, /node scripts\/tv-agent\.js status/);
  assert.match(cliSection, /node scripts\/tv-agent\.js quote/);
  assert.match(cliSection, /node scripts\/tv-agent\.js ohlcv --summary/);
  assert.match(cliSection, /AGENTS\.md/);
  assert.match(cliSection, /skills\/codex-tradingview\/SKILL\.md/);
  assert.ok(cliSection.indexOf('### Codex') < cliSection.indexOf('### Quick Examples'));
});
