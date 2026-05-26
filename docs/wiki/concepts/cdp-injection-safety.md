---
title: CDP injection safety — safeString and requireFinite
type: concept
synthesized_from: working tree
synthesized_on: 2026-05-27
sources:
  - src/connection.js:38
  - src/connection.js:46
related:
  - "[[evaluate-and-known-paths]]"
  - "[[architecture]]"
---

# CDP injection safety

Core functions build JavaScript **as strings** and `evaluate()` them in TV. Any
user-supplied value spliced into that string is a potential code-injection
vector — a symbol like `"; while(true){} //` would execute. Two helpers in
`src/connection.js` exist to prevent this, and a recent hardening pass wired them
across the codebase.

## safeString

`safeString(str)` (`src/connection.js:38`) = `JSON.stringify(String(str))`. It
returns a **fully-quoted, escaped JS string literal** (with surrounding quotes).
Correct usage interpolates it where a value goes, without adding quotes:

```js
// CORRECT — safeString supplies the quotes
var sym = ${safeString(symbol)};
// WRONG — double-quoted, and unescaped:
var sym = "${symbol}";
```

It neutralizes quotes, backticks, template-literal `${}`, and control chars. Use
it for **every** string value that reaches an injected script.

## requireFinite

`requireFinite(value, name)` (`src/connection.js:46`) coerces to Number and
throws unless `Number.isFinite`. Use it for every numeric value before it reaches
a TV API — both to block injection (a non-numeric string can't slip through as a
number) and to stop `NaN`/`Infinity` corrupting TV state that may persist to the
cloud (e.g. visible-range timestamps, indicator inputs).

## History / provenance

Recent commits hardened this: `133963e Fix CDP injection vulnerabilities across 9
modules` and `f23eb1b Add DI and full test coverage for chart.js and drawing.js
sanitization`. So `chart.js` and `drawing.js` have explicit sanitization tests
(`tests/sanitization.test.js`). The dependency-injection seam
([[architecture]] → "DI seam") is what makes that sanitization unit-testable
without a live TV.

## Rule for new code

Any new core function that interpolates input into an `evaluate()` string MUST
route strings through `safeString` and numbers through `requireFinite`. Treat raw
interpolation of user input as a bug.
