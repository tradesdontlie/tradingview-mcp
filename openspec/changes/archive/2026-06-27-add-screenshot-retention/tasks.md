## 1. Retention
- [x] 1.1 Add a retention helper that prunes `screenshots/` by age/count/total-bytes; call it on capture.
- [x] 1.2 Expose retention/persistence options on the capture and batch tool schemas (sensible defaults).

## 2. Capture I/O
- [x] 2.1 Decode the base64 PNG once; reuse the buffer for `writeFile` and `size_bytes`.
- [x] 2.2 Replace `writeFileSync` with `await writeFile` (`fs/promises`) in `capture.js` and `batch.js`.
- [x] 2.3 Sanitize filenames with `path.basename` + an allowlist (alphanumeric/`-`/`_`).
- [x] 2.4 Move `mkdirSync(SCREENSHOT_DIR,…)` before the batch loop.

## 3. Tests
- [x] 3.1 Unit test: a `..`-containing filename writes inside `screenshots/`, not outside.
- [x] 3.2 Unit test: retention prunes beyond the configured cap.

## 4. Validate
- [x] 4.1 `openspec validate add-screenshot-retention --strict`
