import { readFileSync } from 'fs';
import { setSource } from '../src/core/pine.js';
import { smartCompile } from '../src/core/pine.js';

const source = readFileSync('./scripts/us30_engulf_ema_alert.pine', 'utf8');

console.log('Injecting Pine Script...');
const r = await setSource({ source });
console.log('setSource:', JSON.stringify(r, null, 2));

console.log('Compiling...');
const c = await smartCompile({});
console.log('compile:', JSON.stringify(c, null, 2));
