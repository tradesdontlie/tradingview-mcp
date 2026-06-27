/**
 * Offline unit tests for screenshot filename sanitization and retention.
 * No live TradingView required.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm, utimes } from 'fs/promises';
import { tmpdir } from 'os';
import { join, isAbsolute, dirname } from 'path';

import { safeScreenshotName, pruneScreenshots, SCREENSHOT_DIR } from '../src/core/capture.js';

test('safeScreenshotName: traversal segments reduce to a basename inside the dir', () => {
  const cleaned = safeScreenshotName('..\\..\\etc\\hosts');
  // No path separators survive.
  assert.ok(!cleaned.includes('/'), 'no forward slashes');
  assert.ok(!cleaned.includes('\\'), 'no backslashes');
  // Joining with the screenshot dir stays within the dir.
  const full = join(SCREENSHOT_DIR, `${cleaned}.png`);
  assert.equal(dirname(full), SCREENSHOT_DIR, 'resolves inside screenshots dir');
});

test('safeScreenshotName: unix-style traversal also reduced', () => {
  const cleaned = safeScreenshotName('../../../tmp/evil');
  assert.ok(!cleaned.includes('/') && !cleaned.includes('\\'));
  assert.ok(!cleaned.startsWith('.'), 'no leading dot segment');
  assert.equal(cleaned, 'evil');
});

test('safeScreenshotName: weird chars are stripped to allowlist', () => {
  const cleaned = safeScreenshotName('my chart!@#$%^&*()=+name');
  assert.match(cleaned, /^[A-Za-z0-9._-]+$/, 'only allowlisted chars remain');
});

test('safeScreenshotName: a normal name is preserved', () => {
  assert.equal(safeScreenshotName('tv_chart_2026-05-31'), 'tv_chart_2026-05-31');
});

test('safeScreenshotName: empty / dotted name falls back', () => {
  assert.equal(safeScreenshotName(''), 'screenshot');
  assert.equal(safeScreenshotName('...'), 'screenshot');
  assert.equal(safeScreenshotName(null), 'screenshot');
});

test('pruneScreenshots: keeps only the newest maxFiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-shots-'));
  try {
    const N = 10;
    const keep = 3;
    const names = [];
    for (let i = 0; i < N; i++) {
      const name = `shot_${i}.png`;
      const full = join(dir, name);
      await writeFile(full, Buffer.from(`png-${i}`));
      // Stagger mtimes so ordering is deterministic (older = lower index).
      const t = new Date(Date.now() - (N - i) * 60_000);
      await utimes(full, t, t);
      names.push(name);
    }

    const { removed } = await pruneScreenshots({ dir, maxFiles: keep, maxAgeDays: null });

    const survivors = (await readdir(dir)).filter(f => f.endsWith('.png')).sort();
    assert.equal(survivors.length, keep, `only ${keep} files remain`);
    assert.equal(removed.length, N - keep, 'removed the rest');

    // The newest `keep` files (highest indices) should survive.
    const expected = ['shot_7.png', 'shot_8.png', 'shot_9.png'];
    assert.deepEqual(survivors, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pruneScreenshots: removes files older than maxAgeDays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-shots-age-'));
  try {
    // One old (10 days), one fresh.
    const oldFull = join(dir, 'old.png');
    const newFull = join(dir, 'new.png');
    await writeFile(oldFull, Buffer.from('old'));
    await writeFile(newFull, Buffer.from('new'));
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(oldFull, tenDaysAgo, tenDaysAgo);

    const { removed } = await pruneScreenshots({ dir, maxFiles: null, maxAgeDays: 7 });
    const survivors = (await readdir(dir)).filter(f => f.endsWith('.png'));
    assert.deepEqual(survivors, ['new.png']);
    assert.deepEqual(removed, ['old.png']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pruneScreenshots: ignores non-png files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tv-shots-mixed-'));
  try {
    await writeFile(join(dir, 'a.png'), Buffer.from('a'));
    await writeFile(join(dir, 'b.png'), Buffer.from('b'));
    await writeFile(join(dir, 'notes.txt'), Buffer.from('keep me'));
    await pruneScreenshots({ dir, maxFiles: 1, maxAgeDays: null });
    const survivors = (await readdir(dir)).sort();
    assert.ok(survivors.includes('notes.txt'), 'non-png untouched');
    assert.equal(survivors.filter(f => f.endsWith('.png')).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCREENSHOT_DIR is an absolute path', () => {
  assert.ok(isAbsolute(SCREENSHOT_DIR));
});
