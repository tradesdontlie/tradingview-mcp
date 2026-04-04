import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const agentsPath = join(root, 'AGENTS.md');
const skillPath = join(root, 'skills', 'codex-tradingview', 'SKILL.md');
const handoffTargets = [
  join(root, 'skills', 'pine-develop', 'SKILL.md'),
  join(root, 'skills', 'chart-analysis', 'SKILL.md'),
  join(root, 'skills', 'multi-symbol-scan', 'SKILL.md'),
];

function assertInOrder(content, patterns) {
  let lastIndex = -1;

  for (const pattern of patterns) {
    const index = content.slice(lastIndex + 1).search(pattern);
    assert.notEqual(index, -1, `Expected to find ${pattern} in order`);
    lastIndex += index + 1;
  }
}

test('AGENTS.md points Codex at the local TradingView skill and tv-agent entrypoint', () => {
  assert.equal(existsSync(agentsPath), true);

  const content = readFileSync(agentsPath, 'utf8');
  assert.match(content, /skills\/codex-tradingview\/SKILL\.md/);
  assert.match(content, /node scripts\/tv-agent\.js/);
  assertInOrder(content, [
    /node scripts\/tv-agent\.js status/,
    /node scripts\/tv-agent\.js launch/,
    /node scripts\/tv-agent\.js status/,
  ]);
});

test('codex-tradingview skill defines the entry workflow and default command sequences', () => {
  assert.equal(existsSync(skillPath), true);
  for (const target of handoffTargets) {
    assert.equal(existsSync(target), true, `Expected handoff target to exist: ${target}`);
  }

  const content = readFileSync(skillPath, 'utf8');
  assert.match(content, /name:\s*codex-tradingview/);
  assert.match(content, /Use when/i);
  assert.match(content, /status\s*->\s*launch\s*->\s*status/);
  assert.match(content, /state\s*->\s*values\s*->\s*quote/);
  assert.match(content, /ohlcv\s+--summary/);
  assert.match(content, /skills\/pine-develop\/SKILL\.md/);
  assert.match(content, /skills\/chart-analysis\/SKILL\.md/);
  assert.match(content, /skills\/multi-symbol-scan\/SKILL\.md/);
});
