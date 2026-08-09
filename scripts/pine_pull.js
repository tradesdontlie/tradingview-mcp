#!/usr/bin/env node
// Pull current Pine Script source from TradingView editor → scripts/current.pine
import CDP from 'chrome-remote-interface';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'node:url';

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

const src = (await c.Runtime.evaluate({
  expression: '(function(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return null;var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return null;var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0)return eds[0].getValue()}}cur=cur.return}return null})()',
  returnByValue: true,
})).result?.value;

if (!src) { console.error('Could not read Pine editor'); await c.close(); process.exit(1); }

const outPath = fileURLToPath(new URL('../scripts/current.pine', import.meta.url));
writeFileSync(outPath, src);
console.log(`Pulled ${src.split('\n').length} lines → scripts/current.pine`);
await c.close();
