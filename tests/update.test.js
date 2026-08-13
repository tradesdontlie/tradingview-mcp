/**
 * Tests for update() in src/core/update.js.
 * Covers guards (non-git, wrong branch, dirty tree, diverged) and the
 * update path (fast-forward, npm ci only when the lockfile changed).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../src/core/update.js';
import { classifyUpdate } from '../src/core/health.js';

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * Build DI deps simulating a git repo.
 * @param {object} opts — branch, dirty, remoteSha, ahead, behind, lockChanged
 */
function gitDeps({ branch = 'main', dirty = '', remoteSha = OLD, ahead = 0, behind = 0, lockChanged = false, npmFails = false } = {}) {
  const state = { merged: false, npmCi: 0, cmds: [] };
  const deps = {
    existsSync: () => true,
    repoRoot: 'C:/fake/repo',
    execSync: (cmd) => {
      state.cmds.push(cmd);
      if (cmd.includes('rev-parse --abbrev-ref')) return branch;
      if (cmd.includes('status --porcelain')) return dirty;
      if (cmd.includes('rev-parse HEAD')) return state.merged ? remoteSha : OLD;
      if (cmd.includes('fetch origin')) return '';
      if (cmd.includes('rev-parse origin/main')) return remoteSha;
      if (cmd.includes('rev-list --count origin/main..HEAD')) return String(ahead);
      if (cmd.includes('rev-list --count HEAD..origin/main')) return String(behind);
      if (cmd.includes('diff --name-only')) return lockChanged ? 'package-lock.json' : '';
      if (cmd.includes('merge --ff-only')) { state.merged = true; return ''; }
      if (cmd.startsWith('npm ci')) {
        state.npmCi++;
        if (npmFails) throw new Error('EACCES');
        return '';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    },
  };
  return { deps, state };
}

describe('update() — guards', () => {
  it('refuses non-git installs with a clone hint', async () => {
    const { deps } = gitDeps();
    deps.existsSync = () => false;
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /git clone/);
  });

  it('refuses on a non-main branch', async () => {
    const { deps, state } = gitDeps({ branch: 'fix/my-feature' });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.equal(r.branch, 'fix/my-feature');
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('refuses on a dirty working tree and lists changed files', async () => {
    const { deps, state } = gitDeps({ dirty: 'M src/core/data.js\n?? notes.txt' });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.deepEqual(r.changed_files, ['M src/core/data.js', '?? notes.txt']);
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('refuses when local main has commits not on origin', async () => {
    const { deps, state } = gitDeps({ remoteSha: NEW, ahead: 2, behind: 5 });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /fast-forward is not possible/);
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('reports fetch failures without merging', async () => {
    const { deps, state } = gitDeps();
    const orig = deps.execSync;
    deps.execSync = (cmd) => { if (cmd.includes('fetch')) throw new Error('could not resolve host'); return orig(cmd); };
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /fetch failed/);
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });
});

describe('update() — update paths', () => {
  it('reports up_to_date without merging when HEAD matches origin', async () => {
    const { deps, state } = gitDeps({ remoteSha: OLD });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.updated, false);
    assert.equal(r.status, 'up_to_date');
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('fast-forwards and skips npm ci when the lockfile is unchanged', async () => {
    const { deps, state } = gitDeps({ remoteSha: NEW, behind: 3 });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.updated, true);
    assert.equal(r.commits_pulled, 3);
    assert.equal(r.from_commit, OLD.slice(0, 8));
    assert.equal(r.to_commit, NEW.slice(0, 8));
    assert.equal(r.deps_installed, false);
    assert.equal(state.npmCi, 0);
    assert.equal(r.restart_required, true);
  });

  it('runs npm ci when the lockfile changed', async () => {
    const { deps, state } = gitDeps({ remoteSha: NEW, behind: 1, lockChanged: true });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.deps_installed, true);
    assert.equal(state.npmCi, 1);
  });

  it('still reports the code update when npm ci fails, with a warning', async () => {
    const { deps } = gitDeps({ remoteSha: NEW, behind: 1, lockChanged: true, npmFails: true });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.updated, true);
    assert.equal(r.deps_installed, false);
    assert.match(r.warning, /npm ci failed/);
  });
});

// ── Update classification (health check) ─────────────────────────────────

describe('classifyUpdate() — ahead vs behind', () => {
  it('reports neither when the SHAs match, without shelling out', () => {
    const calls = [];
    const result = classifyUpdate(OLD, OLD, (args) => { calls.push(args); return ''; });
    assert.deepEqual(result, { behind: false, ahead: 0 });
    assert.equal(calls.length, 0, 'no git call is needed when the SHAs match');
  });

  // The regression: local main carrying unpushed commits means origin's HEAD is an
  // ancestor of local HEAD. A raw SHA inequality called that an available update and
  // sent the user to tv_update, which then refuses because it cannot fast-forward.
  it('treats an ancestor remote as ahead, not as an available update', () => {
    const git = (args) => {
      if (args.startsWith('merge-base --is-ancestor')) return '';
      if (args.startsWith('rev-list --count')) return '2';
      throw new Error(`unexpected git call: ${args}`);
    };
    assert.deepEqual(classifyUpdate(NEW, OLD, git), { behind: false, ahead: 2 });
  });

  it('reports behind when the remote commit is not an ancestor', () => {
    const git = (args) => {
      if (args.startsWith('merge-base --is-ancestor')) throw new Error('exit status 1');
      throw new Error(`unexpected git call: ${args}`);
    };
    assert.deepEqual(classifyUpdate(OLD, NEW, git), { behind: true, ahead: 0 });
  });

  it('reports behind when the remote commit is absent from the local object DB', () => {
    const git = () => { throw new Error('fatal: Not a valid object name'); };
    assert.deepEqual(classifyUpdate(OLD, NEW, git), { behind: true, ahead: 0 });
  });

  it('never passes a non-hex remote sha to git', () => {
    const calls = [];
    const git = (args) => { calls.push(args); return ''; };
    const result = classifyUpdate(OLD, 'abc123 && echo pwned', git);
    assert.deepEqual(result, { behind: false, ahead: 0 });
    assert.equal(calls.length, 0, 'a malformed sha must never reach a shell command');
  });
});
