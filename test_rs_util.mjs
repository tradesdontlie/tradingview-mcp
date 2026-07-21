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
console.log('ALL PASS');
