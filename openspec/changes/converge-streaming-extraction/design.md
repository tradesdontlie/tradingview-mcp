## Context
`data.js` and `stream.js` independently extract the same TradingView internals (study values, pine
lines/labels/tables/boxes). `897366e` converged `data.js` onto deterministic paths but left
`stream.js` on the older shapes. The two now drift, and only `data.js` has a `_deps` test seam. This
change decides how to converge them without destabilizing the streaming hot path.

## Goals / Non-Goals
- Goals: one source of truth for the page-side extraction JS; equivalent output from `data_*` tools and
  the `stream *` outputs for the same chart state; offline test coverage for the stream extractors;
  bounded error handling in the poll loop.
- Non-Goals: changing the JSONL stream output schema or fingerprint/dedup logic; changing tool/CLI
  surfaces; re-tuning poll intervals.

## Decisions
- **Decision:** Extract the page-side extraction strings in `data.js` (`buildAllGraphicsJS`,
  `graphicsExtractSnippet`, and the study-values snippet) into reusable builders and have `stream.js`
  call them, rather than re-pointing `stream.js`'s hand-written extractors one field at a time. This
  collapses the two extractors to one and guarantees parity.
  - Alternatives considered: (a) field-by-field re-point of the existing stream extractors — smaller
    diff but the two copies can still drift; (b) route streams through the `data.js` core functions
    directly — cleanest, but those return shaped/deduped results while the stream wants raw per-cycle
    payloads, so a shared *builder* (not the shaped function) is the right seam.
- **Decision:** Generalize the poll loop's existing consecutive-error counter to cover every caught
  error; keep the faster transport-specific messaging but apply the same backoff + escalate-after-N to
  non-transport errors, with a terminal bail-out so a permanently-broken page state ends the stream.

## Risks / Trade-offs
- Sharing builders couples `stream.js` to `data.js` internals → mitigate by exporting a small, named
  builder API and covering it with the parity unit test.
- Bounding non-CDP errors could end a stream that would have self-recovered → mitigate with a generous
  escalate-after-N threshold and a clear terminal log line.

## Migration Plan
No data migration. Behavior change is limited to (a) stream outputs now matching `data_*` results and
(b) a non-transport error storm terminating instead of looping. Roll back by reverting the module.

## Open Questions
- Should the streaming `values` output adopt `entity_id` disambiguation like `data.js getStudyValues`
  now returns? Deferred unless a consumer needs it.
