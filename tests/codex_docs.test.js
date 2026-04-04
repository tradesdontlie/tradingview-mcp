import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readmePath = join(__dirname, '..', 'README.md');

test('README documents the Codex CLI entrypoint and guidance files', () => {
  const content = readFileSync(readmePath, 'utf8');

  assert.match(content, /Codex/i);
  assert.match(content, /node scripts\/tv-agent\.js/);
  assert.match(content, /AGENTS\.md/);
  assert.match(content, /skills\/codex-tradingview\/SKILL\.md/);
});
