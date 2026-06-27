## Context
The report pipeline calls the four pine-graphics tools in sequence on charts with many commercial
indicators, so the O(studies × primitives) cost and the 4× payload rebuild dominate report latency.
Streaming pays a separate, continuous serialization tax. Both are structural, not algorithmic-hard.

## Goals / Non-Goals
- Goals: skip irrelevant studies early; one round-trip for all four graphics types; cheaper dedup;
  numeric study values.
- Non-Goals: a persistent cache layer (optional, deferred); changing what data the tools expose.

## Decisions
- **Decision:** Move the `study_filter` name check to the top of the per-source loop, before reading
  `_graphics`/primitives.
- **Decision:** Add a `getAllGraphics()` core that returns `{lines, labels, tables, boxes}` in one
  evaluate; keep the four tool entry points as thin client-side splitters for backward compatibility.
- **Decision:** Stream dedup uses a per-stream fingerprint function (quotes: `time:close:volume`;
  values: `entityId:plot…`); fall back to full stringify only for variable-shape streams. Emit line is
  serialized once.
- **Decision:** Return numbers from `getStudyValues`; document the change. (If a consumer truly needs
  fixed strings, formatting belongs in the presentation layer.)
- Alternatives considered: short-TTL cache keyed on study-list hash — deferred; only justified for
  streaming and adds invalidation complexity.

## Risks / Trade-offs
- Numeric values are **BREAKING** for anything that did string comparisons → called out; low real risk
  since numeric is the expected shape.
- A shared graphics payload is larger per call but replaces four calls → net win for the report path.

## Migration Plan
- Land early-filter + numeric values first (small, isolated). Then the shared `getAllGraphics()` with the
  four tools delegating. Then stream fingerprints.

## Open Questions
- Whether to expose `getAllGraphics()` as its own MCP tool or keep it internal (proposed: internal).
