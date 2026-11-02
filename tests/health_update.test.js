/**
 * Tests for checkForUpdate() in src/core/health.js.
 * Covers the ahead-of-upstream case (local commits on top of origin), genuine
 * staleness, and the local-HEAD-vs-network caching split.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, _resetUpdateCache } from '../src/core/health.js';

const LOCAL = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);
const ORIGIN = 'https://github.com/owner/repo.git';

/**
 * Build a _deps bundle backed by a fake git.
 * @param {object} opts
 *   head        — what `git rev-parse HEAD` returns
 *   remoteSha   — what the GitHub API returns (null simulates offline)
 *   hasObject   — remote sha exists in the local object store
 *   isAncestor  — remote sha is an ancestor of HEAD
 */
function deps({ head = LOCAL, remoteSha = REMOTE, hasObject = true, isAncestor = false } = {}) {
  const calls = { rev: 0, fetch: 0 };
  return {
    calls,
    _deps: {
      now: () => 1_000_000,
      fetchRemoteSha: async () => { calls.fetch++; return remoteSha; },
      execSync: (cmd) => {
        if (cmd === 'git rev-parse HEAD') { calls.rev++; return Buffer.from(head + '\n'); }
        if (cmd.startsWith('git config')) return Buffer.from(ORIGIN + '\n');
        if (cmd.startsWith('git cat-file')) {
          if (!hasObject) throw new Error('Not a valid object name');
          return Buffer.from('commit\n');
        }
        if (cmd.startsWith('git merge-base')) {
          if (!isAncestor) throw Object.assign(new Error('exit 1'), { status: 1 });
          return Buffer.from('');
        }
        throw new Error('unexpected command: ' + cmd);
      },
    },
  };
}

describe('checkForUpdate() — ahead of upstream', () => {
  beforeEach(() => _resetUpdateCache());

  it('reports no update when the remote commit is already an ancestor of HEAD', async () => {
    const d = deps({ isAncestor: true });
    const r = await checkForUpdate(d);
    assert.equal(r.update_available, false);
    assert.equal(r.hint, undefined, 'must not tell the user to overwrite their own commits');
  });

  it('still reports the upstream sha so the user can see the gap', async () => {
    const r = await checkForUpdate(deps({ isAncestor: true }));
    assert.equal(r.local_commit, LOCAL.slice(0, 8));
    assert.equal(r.latest_commit, REMOTE.slice(0, 8));
  });
});

describe('checkForUpdate() — genuinely behind', () => {
  beforeEach(() => _resetUpdateCache());

  it('reports an update when the remote commit is not an ancestor', async () => {
    const r = await checkForUpdate(deps({ isAncestor: false }));
    assert.equal(r.update_available, true);
    assert.match(r.hint, /tv_update/);
  });

  it('reports an update when the remote commit was never fetched locally', async () => {
    const r = await checkForUpdate(deps({ hasObject: false }));
    assert.equal(r.update_available, true);
  });

  it('reports no update when HEAD and upstream are identical', async () => {
    const r = await checkForUpdate(deps({ head: REMOTE }));
    assert.equal(r.update_available, false);
    assert.equal(r.hint, undefined);
  });
});

describe('checkForUpdate() — caching', () => {
  beforeEach(() => _resetUpdateCache());

  it('re-reads local HEAD on every call but fetches the remote sha once', async () => {
    const d = deps({ isAncestor: true });
    await checkForUpdate(d);
    await checkForUpdate(d);
    await checkForUpdate(d);
    assert.equal(d.calls.rev, 3, 'local HEAD must not be cached — a new commit shows up at once');
    assert.equal(d.calls.fetch, 1, 'the network lookup stays cached');
  });
});

describe('checkForUpdate() — failure modes', () => {
  beforeEach(() => _resetUpdateCache());

  it('returns null when offline', async () => {
    assert.equal(await checkForUpdate(deps({ remoteSha: null })), null);
  });

  it('returns null outside a git checkout', async () => {
    const r = await checkForUpdate({
      _deps: { execSync: () => { throw new Error('not a git repository'); } },
    });
    assert.equal(r, null);
  });

  it('returns null on a malformed HEAD rather than guessing', async () => {
    assert.equal(await checkForUpdate(deps({ head: 'ref: refs/heads/main' })), null);
  });
});
