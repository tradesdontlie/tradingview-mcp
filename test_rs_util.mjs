import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVnindexCache, writeVnindexCache } from './rs_util.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-cache-'));
const cache = path.join(root, 'vnindex_h6.json');
assert.equal(readVnindexCache(cache), null);
writeVnindexCache([100, 101], cache);
assert.deepEqual(readVnindexCache(cache).closes, [100, 101]);
const now = Date.now();
fs.writeFileSync(cache, JSON.stringify({ ts: now - 3 * 3600 * 1000, closes: [100, 101] }));
assert.equal(readVnindexCache(cache, 2 * 3600 * 1000).fresh, false);
fs.writeFileSync(cache, JSON.stringify({ ts: now - 60 * 60 * 1000, closes: [100, 101] }));
assert.equal(readVnindexCache(cache, 2 * 3600 * 1000).fresh, true);
fs.writeFileSync(cache, JSON.stringify({ ts: now - 35 * 3600 * 1000, closes: [100, 101] }));
assert.equal(readVnindexCache(cache).fresh, true);
console.log('ALL PASS');
