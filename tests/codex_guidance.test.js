import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const packagePath = join(root, 'package.json');
const agentsPath = join(root, 'AGENTS.md');
const agentScriptPath = join(root, 'scripts', 'tv-agent.js');
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
  assert.equal(existsSync(agentScriptPath), true);

  const content = readFileSync(agentsPath, 'utf8');
  assert.match(content, /skills\/codex-tradingview\/SKILL\.md/);
  assert.match(content, /node scripts\/tv-agent\.js/);
  assertInOrder(content, [
    /node scripts\/tv-agent\.js status/,
    /node scripts\/tv-agent\.js launch --no-kill/,
    /node scripts\/tv-agent\.js status/,
  ]);
});

test('package.json wires codex guidance into the codex validation script', () => {
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));

  assert.match(manifest.scripts['tv:agent'], /^node scripts\/tv-agent\.js$/);
  assert.match(manifest.scripts['test:codex'], /tests\/codex_guidance\.test\.js/);
});

test('package.json keeps npm test on the offline codex-aware path', () => {
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));

  assert.doesNotMatch(manifest.scripts.test, /tests\/e2e\.test\.js/);
  assert.match(manifest.scripts.test, /tests\/sanitization\.test\.js/);
  assert.match(manifest.scripts.test, /tests\/replay\.test\.js/);
  assert.match(manifest.scripts.test, /tests\/codex_agent_wrapper\.test\.js/);
  assert.match(manifest.scripts.test, /tests\/codex_guidance\.test\.js/);
  assert.match(manifest.scripts.test, /tests\/codex_docs\.test\.js/);
});

test('codex-tradingview skill defines the entry workflow and default command sequences', () => {
  assert.equal(existsSync(skillPath), true);
  for (const target of handoffTargets) {
    assert.equal(existsSync(target), true, `Expected handoff target to exist: ${target}`);
  }

  const content = readFileSync(skillPath, 'utf8');
  assert.match(content, /name:\s*codex-tradingview/);
  assert.match(content, /Use when/i);
  assert.match(content, /status\s*->\s*launch\s*--no-kill\s*->\s*status/);
  assert.match(content, /state\s*->\s*values\s*->\s*quote/);
  assert.match(content, /ohlcv\s+--summary/);
  assert.match(content, /skills\/pine-develop\/SKILL\.md/);
  assert.match(content, /skills\/chart-analysis\/SKILL\.md/);
  assert.match(content, /skills\/multi-symbol-scan\/SKILL\.md/);
});
