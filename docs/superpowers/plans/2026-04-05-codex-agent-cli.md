# Codex Agent CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Codex がこのリポジトリ内で `tv` CLI を安定して使えるようにし、TradingView 関連タスクで迷わず正しい入口と判断順序を踏めるようにする。

**Architecture:** 既存の `src/cli/index.js` はそのまま活かし、Codex 専用の薄いラッパーを `scripts/` に追加する。Codex へのプロジェクト固有ルールは `AGENTS.md` とリポジトリ内スキルに集約し、README ではその導線だけを短く案内する。

**Tech Stack:** Node.js 18+、既存の `node:test`、既存 CLI (`src/cli/index.js`)、Markdown ベースの `AGENTS.md` と `skills/`

---

### Task 1: Codex 用 CLI ラッパーを追加する

**Files:**
- Create: `scripts/tv-agent.js`
- Create: `tests/codex_agent_wrapper.test.js`
- Modify: `package.json`
- Reference: `src/cli/index.js`
- Reference: `tests/cli.test.js`

- [ ] **Step 1: ラッパーの失敗テストを書く**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(__dirname, '..', 'scripts', 'tv-agent.js');

test('wrapper shows tv help from any cwd', () => {
  const result = spawnSync('node', [WRAPPER, '--help'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: tv/);
});

test('wrapper preserves CLI exit code for unknown commands', () => {
  const result = spawnSync('node', [WRAPPER, 'nonexistent'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command/);
});
```

- [ ] **Step 2: テストを実行して正しく失敗することを確認する**

Run: `node --test tests/codex_agent_wrapper.test.js`

Expected: FAIL。`scripts/tv-agent.js` が存在しないか、ラッパー未実装によりアサーションが失敗する。

- [ ] **Step 3: 最小実装でラッパーを追加する**

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(__dirname, '..', 'src', 'cli', 'index.js');

const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
```

`package.json` には少なくとも以下を追加する。

```json
{
  "scripts": {
    "tv:agent": "node scripts/tv-agent.js",
    "test:codex": "node --test tests/codex_agent_wrapper.test.js tests/codex_guidance.test.js tests/codex_docs.test.js"
  }
}
```

- [ ] **Step 4: テストを再実行して通ることを確認する**

Run: `node --test tests/codex_agent_wrapper.test.js`

Expected: PASS。`--help` が `Usage: tv` を表示し、未知コマンドで終了コード `1` を返す。

- [ ] **Step 5: コミットする**

```bash
git add scripts/tv-agent.js tests/codex_agent_wrapper.test.js package.json
git commit -m "feat: add Codex CLI wrapper"
```

### Task 2: Codex 専用スキルと AGENTS 導線を追加する

**Files:**
- Create: `AGENTS.md`
- Create: `skills/codex-tradingview/SKILL.md`
- Create: `tests/codex_guidance.test.js`
- Reference: `CLAUDE.md`
- Reference: `skills/chart-analysis/SKILL.md`
- Reference: `skills/pine-develop/SKILL.md`
- Reference: `skills/multi-symbol-scan/SKILL.md`

- [ ] **Step 1: 導線の失敗テストを書く**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const agentsPath = join(root, 'AGENTS.md');
const skillPath = join(root, 'skills', 'codex-tradingview', 'SKILL.md');

test('AGENTS.md exists and points Codex to the local TradingView skill', () => {
  assert.equal(existsSync(agentsPath), true);
  const content = readFileSync(agentsPath, 'utf8');
  assert.match(content, /skills\/codex-tradingview\/SKILL\.md/);
  assert.match(content, /node scripts\/tv-agent\.js status/);
});

test('codex-tradingview skill defines the entry workflow', () => {
  assert.equal(existsSync(skillPath), true);
  const content = readFileSync(skillPath, 'utf8');
  assert.match(content, /name:\s*codex-tradingview/);
  assert.match(content, /Use when/i);
  assert.match(content, /status/);
  assert.match(content, /launch/);
  assert.match(content, /state.*values.*quote/s);
});
```

- [ ] **Step 2: テストを実行して正しく失敗することを確認する**

Run: `node --test tests/codex_guidance.test.js`

Expected: FAIL。`AGENTS.md` または `skills/codex-tradingview/SKILL.md` がまだ存在しない。

- [ ] **Step 3: AGENTS.md と専用スキルを最小実装する**

`AGENTS.md` には少なくとも以下を入れる。

```md
# Agent Notes

When working in this repository on TradingView analysis or automation tasks:

1. Read `skills/codex-tradingview/SKILL.md` first.
2. Use `node scripts/tv-agent.js ...` instead of assuming `tv` is on PATH.
3. Start with `node scripts/tv-agent.js status`.
4. If TradingView is not connected, try `node scripts/tv-agent.js launch`.
```

`skills/codex-tradingview/SKILL.md` には少なくとも以下を入れる。

```md
---
name: codex-tradingview
description: Use when Codex is working inside this repository and needs to inspect, analyze, or control TradingView through the local CLI wrapper.
---

# Codex TradingView Entry Workflow

Use `node scripts/tv-agent.js` as the default entrypoint.

## First checks

1. Run `node scripts/tv-agent.js status`
2. If disconnected, run `node scripts/tv-agent.js launch`
3. Re-run `node scripts/tv-agent.js status`

## Default command sequences

- Chart snapshot: `state` -> `values` -> `quote`
- Price history: `ohlcv --summary`
- Pine work: hand off to `skills/pine-develop/SKILL.md`
- Chart review: hand off to `skills/chart-analysis/SKILL.md`
- Multi-symbol scanning: hand off to `skills/multi-symbol-scan/SKILL.md`

## Guardrails

- Prefer small outputs first
- Avoid raw source reads unless needed
- Prefer filters when a study is already known
```

- [ ] **Step 4: テストを再実行して通ることを確認する**

Run: `node --test tests/codex_guidance.test.js`

Expected: PASS。`AGENTS.md` がローカルスキルとラッパーコマンドを参照し、スキルが接続確認と基本分岐を定義している。

- [ ] **Step 5: コミットする**

```bash
git add AGENTS.md skills/codex-tradingview/SKILL.md tests/codex_guidance.test.js
git commit -m "feat: add Codex TradingView project guidance"
```

### Task 3: README に Codex 向け導線を追加する

**Files:**
- Create: `tests/codex_docs.test.js`
- Modify: `README.md`

- [ ] **Step 1: README の失敗テストを書く**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readmePath = join(__dirname, '..', 'README.md');

test('README documents the Codex entrypoint', () => {
  const content = readFileSync(readmePath, 'utf8');
  assert.match(content, /Codex/i);
  assert.match(content, /node src\/cli\/index\.js|node scripts\/tv-agent\.js/);
  assert.match(content, /AGENTS\.md/);
});
```

- [ ] **Step 2: テストを実行して正しく失敗することを確認する**

Run: `node --test tests/codex_docs.test.js`

Expected: FAIL。README に Codex 向け導線や `AGENTS.md` への参照がまだない。

- [ ] **Step 3: README に最小の Codex セクションを追加する**

追加先は CLI セクション付近にする。内容は短く保つ。

```md
## Use with Codex

Codex should use the repository-local wrapper instead of assuming `tv` is on PATH.

```bash
node scripts/tv-agent.js status
node scripts/tv-agent.js quote
node scripts/tv-agent.js ohlcv --summary
```

Project-specific Codex guidance lives in `AGENTS.md` and `skills/codex-tradingview/SKILL.md`.
```

- [ ] **Step 4: テストを再実行して通ることを確認する**

Run: `node --test tests/codex_docs.test.js`

Expected: PASS。README から Codex の入口と参照先が分かる。

- [ ] **Step 5: コミットする**

```bash
git add README.md tests/codex_docs.test.js
git commit -m "docs: add Codex usage guide"
```

### Task 4: 集約テストとスモーク確認を行う

**Files:**
- Modify: `package.json` (必要ならテスト対象へ新規ファイルを追加)
- Reference: `tests/codex_agent_wrapper.test.js`
- Reference: `tests/codex_guidance.test.js`
- Reference: `tests/codex_docs.test.js`

- [ ] **Step 1: 新規テストをまとめて実行するコマンドを確認する**

```json
{
  "scripts": {
    "test:codex": "node --test tests/codex_agent_wrapper.test.js tests/codex_guidance.test.js tests/codex_docs.test.js",
    "test:unit": "node --test tests/pine_analyze.test.js tests/cli.test.js tests/codex_agent_wrapper.test.js tests/codex_guidance.test.js tests/codex_docs.test.js"
  }
}
```

- [ ] **Step 2: フルの Codex 関連テストを実行する**

Run: `npm run test:codex`

Expected: PASS。3 つの新規テストファイルがすべて通る。

- [ ] **Step 3: 既存のユニット系テストと合わせて再確認する**

Run: `npm run test:unit`

Expected: PASS。既存 CLI テストと新規 Codex テストが共存する。

- [ ] **Step 4: リポジトリ内から実 CLI スモークを行う**

Run: `node scripts/tv-agent.js --help`

Expected: PASS。`Usage: tv` を表示して終了コード `0`。

可能なら追加で以下も確認する。

Run: `node scripts/tv-agent.js status`

Expected:
- TradingView 未接続なら終了コード `2` と JSON エラー
- TradingView 接続済みなら成功 JSON

- [ ] **Step 5: 最終コミットを行う**

```bash
git add package.json
git commit -m "test: verify Codex TradingView workflow"
```

## 実行メモ

- 実装中は常に `node scripts/tv-agent.js ...` を標準経路として使う
- `tv` グローバルコマンド前提の記述は増やさない
- リポジトリ内スキルは `AGENTS.md` から辿れる状態にする
- README は短く、詳細ルールは `AGENTS.md` と `skills/codex-tradingview/SKILL.md` に寄せる
