## 1. Early filtering
- [x] 1.1 In `buildGraphicsJS`, test `study_filter` against the study name before reading
      `_graphics`/primitives; `continue` early on non-match.

## 2. Shared round-trip
- [x] 2.1 Add a core `getAllGraphics()` returning `{lines, labels, tables, boxes}` in one evaluate.
- [x] 2.2 Re-point the four readers/tools to split the shared result client-side.

## 3. study_filter + numeric values
- [x] 3.1 Add optional `study_filter` to `getStudyValues` and `data_get_study_values`.
- [x] 3.2 Return indicator values as numbers; update the tool schema/description accordingly.

## 4. Stream dedup
- [x] 4.1 Replace full-payload `JSON.stringify` dedup with a per-stream shallow fingerprint.
- [x] 4.2 Serialize the emitted JSONL line only once.

## 5. Tests
- [x] 5.1 Unit test: filtered graphics read does not traverse non-matching studies (spy on the payload).
- [x] 5.2 Unit test: dedup suppresses an unchanged poll using the fingerprint.

## 6. Validate
- [x] 6.1 `openspec validate optimize-pine-graphics-and-streaming --strict`
