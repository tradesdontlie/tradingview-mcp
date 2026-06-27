# Change: Add screenshot retention and safer capture I/O

## Why
Both screenshot entry points (`src/core/capture.js`, `src/core/batch.js`) write every PNG into the
repo-root `screenshots/` directory with no retention, cap, or pruning — the daily report pipeline
produces 7+ per day and 35 files were already present at audit time (A1 P-4, A2 P-4, A3 P-7, A5 P-3).
Three smaller capture-path issues ride along: the base64 payload is decoded twice (once to write, once
for `size_bytes`) (A3 P-5); `writeFileSync` blocks the stdio event loop on 100–500KB PNGs (A4 P-5);
filename sanitization only strips slashes so `..` segments survive (`..\..\etc\hosts`), a path-traversal
risk (A3 B-7); and `mkdirSync` runs inside the batch loop (A3 P-6).

## What Changes
- Add a configurable retention policy (by age, count, or total bytes) that prunes old screenshots; make
  persistence configurable (default-on for the report pipeline).
- Decode the base64 PNG once, reuse the buffer for both write and `size_bytes`.
- Switch to async `fs/promises.writeFile` so the stdio transport isn't blocked.
- Sanitize output filenames with `path.basename` (plus an allowlist) to prevent traversal.
- Move `mkdir` out of the batch loop.

## Impact
- Affected specs: `screenshot-management` (new capability)
- Affected code: `src/core/capture.js`, `src/core/batch.js`, tool schemas (`src/tools/capture.js`,
  `src/tools/batch.js`) for the retention/persistence options, `tests/`
