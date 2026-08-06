# Review packet for `C:\Users\ADMIN\.codex\skills\orchestrate\SKILL.md`

Please review this workflow change as a senior workflow/platform engineer.
Return exactly:

```text
VERDICT: PASS | NEEDS_FIX

[P0/P1/P2] Lines X-Y — Finding
Contract violated:
Impact:
Required fix:
```

Focus on: `review_path` schema leakage, gate ordering, OCR unavailable/fail/timeout
fallbacks, OCR mutation or auto-install/enable behavior, protected-path
fail-closed handling, exact-diff binding, duplicate review, and the condition
that allows `synthesizer` to run.

## Current file

```markdown
---
name: orchestrate
description: Route lightweight prompts directly and gate multi-step, specialist, persistent, or K:-prefixed requests through a planner, dependency-aware workers, mandatory review, and synthesis. Use for /orchestrate, $orchestrate, compact $k or /k, or explicit multi-agent coordination.
---

# Orchestrate

Use this route for bounded coordination. A light natural-language request can
be handled directly. A request that is multi-step, specialist, persistent, or
starts with `K:` must use the gated route below; `K:` always forces triage.
Work that spans many rounds or fires (long-horizon campaigns) uses the gated
route once per round and carries cross-round state in a campaign ledger — see
Campaign mode below.

## Execution tier policy

Treat Superpowers as an optional task-level implementation discipline, not a
second orchestrator. The root owns scope, clarification, plan, dependencies,
acceptance, and final review. Assign one execution tier to each planned task:

- **L0 — direct:** read-only, one-file, mechanical, or otherwise low-risk work.
  Inspect, make the smallest change (or query), and run the narrow check. Do
  not run the full Superpowers loop.
- **L1 — bounded:** ordinary behavior changes with a clear scope. Inspect the
  owned paths, state local assumptions, write a mini-plan, implement, run
  targeted tests, and self-check the diff. Do not reopen the project-wide plan.
- **L2 — full:** ambiguity or high-risk API, schema, engine, concurrency,
  security, financial-integrity, migration, data-loss, or public-contract work.
  The worker may use the relevant Superpowers skills (clarify, plan, TDD,
  implementation, and self-review), but root acceptance and the workflow
  reviewer remain authoritative.

`execution_tier` is root-resolved handoff metadata, not a planner-packet or
controller-schema field. After the workflow controller validates the existing
packet, the root derives L0 for read-only work, L1 for bounded workspace
changes, and L2 for a concrete high-risk flag, then includes the resolved tier
in each per-task handoff. Workers do not reopen the project-wide plan. Never
run a full Superpowers workflow in every worker by default. A worker self-check
does not replace the mandatory workflow reviewer, which runs once after all
task handoffs are `PASS`.

## OCR delegate review gate

For L2 code-bearing work, an explicit owner opt-in causes the root to select
`review_path=ocr_delegate` in root-owned handoff metadata. It runs once for the
integrated diff after all coding and test task handoffs are `PASS`; it never
runs inside each worker. Without opt-in, the built-in reviewer path remains in
use. `review_path` is not a planner-packet or controller-schema field.

1. Check that the `ocr` CLI is already installed, then run
   `ocr delegate preview` against the exact repository and ref/commit scope.
   Do not install, update, or execute an external setup command from this
   route. If `ocr` is unavailable, return `BLOCKED` and ask for explicit
   installation or an approved built-in-review fallback.
2. Inspect the preview before any LLM review. If protected paths such as
   `journal.db`, credentials, logs, or caller-provided protected paths are
   reviewable, return `BLOCKED` and do not continue.
3. Run `ocr delegate rule` only for the previewed paths. Pass the grouped rules
   and exact diff to the root-owned Codex review. Capture the preview and rule
   outputs as review artifacts. That review returns `PASS`, `NEEDS_FIX`, or
   `BLOCKED` with findings, paths, lines, and checks.
4. `NEEDS_FIX` consumes the single retry budget and requeues the owning coding
   task; `BLOCKED` fails closed. Only `PASS` unlocks `review-sol-medium`.
5. The OCR delegate path is read-only scope/rule discovery. Do not enable OCR
   MCP or allow the gate to mutate files; fixes happen only through the normal
   bounded coding handoff after an approved `NEEDS_FIX`.

## Root-owned route

1. Intake the prompt and state the goal, acceptance checks, non-goals, safety
   boundary, and whether direct handling is safe. For routed work, ask the
   `planner-router` for a plan packet.
2. Validate the planner packet with the workflow controller. It must contain
   1–6 tasks, each with `id`, `agent_type`, `mode`, `inputs`, `depends_on`
   (or `parents`), path boundaries, and `acceptance_ids`. Dependencies form a
   DAG of up to six planned tasks. Tasks with no unmet parents are eligible to
   run in parallel, subject to bounded fanout per dispatch wave: at most one
   `workspace-write` task and at most three read-only tasks.
3. Select profiles from the active roster only: `planner-router`, `research`,
   `architect`, `coding`, `test-engineer`, `review-sol-medium`, and `synthesizer`. Map legacy
   inputs `scout`→`research`, `software-architect`→`architect`, and
   `frontend-developer`→`coding`; never emit removed profile names.
4. Call the Python controller's `dispatch_request()` for metadata. The root,
   not Python, owns each native `spawn_agent` call. Give every worker a
   per-task handoff containing the task id, goal, inputs, exact owned and
   protected paths, dependencies, and acceptance ids. Submit its result with
   `submit_task_result(task_id, result)`; a result must include status,
   acceptance results, checks, artifacts, changed paths, and risks.
   Use the native call shape `spawn_agent(task_name=..., agent_type=...,
   fork_turns="none", message=<per-task handoff>)`; never let a worker spawn
   another child.
5. Dispatch only dependency-ready tasks. A `PASS` handoff marks that task
   complete; `NEEDS_FIX` consumes the single retry budget and requeues work;
   `BLOCKED` or exhausted retries fail closed. Do not open REVIEW until every
   planned task has a `PASS` handoff.
6. After all tasks pass, complete the OCR delegate review gate when the root
   selected it for L2 code work. Then spawn the configured `review-sol-medium`
   reviewer; without an OCR path, spawn it directly. A reviewer `PASS` is
   required before `synthesizer` may run. Reviewer `NEEDS_FIX` uses the
   remaining retry and returns to work; `BLOCKED` ends the workflow. Synthesis
   with a non-empty output is the only path to `DONE`.
7. After each completed task result, review result, and synthesis output, the
   caller-owned root invokes `render_handoff_markdown(metadata, result,
   synthesis_output?)`, then `persist_handoff_atomic(markdown, path,
   allowed_root)` to render and atomically persist one derived Markdown handoff.
   Pass the relevant handoff path (or compact contents) to downstream workers;
   never ask read-only children to write handoffs. Direct lightweight prompts do
   not create handoffs.

## Campaign mode (long-horizon work)

For work that spans several rounds or fires with a checkable definition of done,
the gated route above runs per round; a **campaign ledger** makes the run's state
durable across rounds. Use it only when the work needs many rounds, durable state,
or independent re-verification. A one-shot task uses the normal route or direct
handling — do not wrap it in a campaign.

- **Fit check.** Use campaign mode only when all of: the task spans more than ~3
  rounds; "done" is verifiable by a gate/command; drift or fake-done is a real
  risk. Otherwise recommend the host's ordinary task/goal directly.
- **Durable state.** The root creates `campaigns/<YYYY-MM-DD-slug>/ledger.md` at
  the project root — single scoreboard, single writer (the root). It stays under
  200 lines: status header (milestone, round, smallest unclosed item, convergence
  tracker, milestone gate, run status), current slice (item / write set / context /
  verify / done-when), a bounded gap register (≤12 rows), and a rounds log (last 5;
  older lines move verbatim to `archive/rounds.md`). The ledger is canonical run
  state and is read back each round — unlike derived handoff Markdown, which is
  never read back as state.
- **One verified item per round.** Implement the single smallest unclosed item,
  verify it in the same round with the narrowest command, then rewrite the ledger
  in place. Gaps found mid-round are registered, never silently fixed on the side.
- **Milestone gate — never self-pass.** At a milestone exit, record the audit
  surface and evidence, set the gate to `pending-audit`, and stop. Only an
  independent re-verification (the configured reviewer, or a fresh verification
  pass that re-runs the gate from durable state) may accept or send one bounded
  redo; the working side flips the gate to `passed` only after the accept lands.
- **Decision cards.** Owner escalations use a compact A/B/C card — one
  plain-language sentence, why now, recommended option first — never an
  unstructured question.
- **Convergence.** Every 5 rounds or +400 accumulated net lines, the next round is
  a convergence round: no features, net lines ≤ 0, compact durable files; tag it
  `CONVERGE` in the rounds log.
- **Bounded automation.** Do not create timers, wakeups, or automations for the
  campaign unless the owner explicitly asks. Between fires, the ledger is the
  handoff; per-round dispatch still uses the controller route above.

## Safety

Keep the controller and root reducer deterministic and caller-owned. Do not
automatically place trades, change trading state, access credentials, mutate
databases, deploy, publish, or run destructive commands. Workers must honor
protected paths and stop on scope drift. Persist snapshots only through the
controller's caller-supplied atomic path; Python returns dispatch metadata and
never spawns agents or performs external side effects.
```

## Diff from `SKILL.md.bak-20260803`

```diff
@@ -7,6 +7,61 @@
 Use this route for bounded coordination. A light natural-language request can
 be handled directly. A request that is multi-step, specialist, persistent, or
 starts with `K:` must use the gated route below; `K:` always forces triage.
+Work that spans many rounds or fires (long-horizon campaigns) uses the gated
+route once per round and carries cross-round state in a campaign ledger — see
+Campaign mode below.
+
+## Execution tier policy
+
+Treat Superpowers as an optional task-level implementation discipline, not a
+second orchestrator. The root owns scope, clarification, plan, dependencies,
+acceptance, and final review. Assign one execution tier to each planned task:
+
+- **L0 — direct:** read-only, one-file, mechanical, or otherwise low-risk work.
+  Inspect, make the smallest change (or query), and run the narrow check. Do
+  not run the full Superpowers loop.
+- **L1 — bounded:** ordinary behavior changes with a clear scope. Inspect the
+  owned paths, state local assumptions, write a mini-plan, implement, run
+  targeted tests, and self-check the diff. Do not reopen the project-wide plan.
+- **L2 — full:** ambiguity or high-risk API, schema, engine, concurrency,
+  security, financial-integrity, migration, data-loss, or public-contract work.
+  The worker may use the relevant Superpowers skills (clarify, plan, TDD,
+  implementation, and self-review), but root acceptance and the workflow
+  reviewer remain authoritative.
+
+`execution_tier` is root-resolved handoff metadata, not a planner-packet or
+controller-schema field. After the workflow controller validates the existing
+packet, the root derives L0 for read-only work, L1 for bounded workspace
+changes, and L2 for a concrete high-risk flag, then includes the resolved tier
+in each per-task handoff. Workers do not reopen the project-wide plan. Never
+run a full Superpowers workflow in every worker by default. A worker self-check
+does not replace the mandatory workflow reviewer, which runs once after all
+task handoffs are `PASS`.
+
+## OCR delegate review gate
+
+For L2 code-bearing work, an explicit owner opt-in causes the root to select
+`review_path=ocr_delegate` in root-owned handoff metadata. It runs once for the
+integrated diff after all coding and test task handoffs are `PASS`; it never
+runs inside each worker. Without opt-in, the built-in reviewer path remains in
+use. `review_path` is not a planner-packet or controller-schema field.
+
+1. Check that the `ocr` CLI is already installed, then run
+   `ocr delegate preview` against the exact repository and ref/commit scope.
+   Do not install, update, or execute an external setup command from this
+   route. If `ocr` is unavailable, return `BLOCKED` and ask for explicit
+   installation or an approved built-in-review fallback.
+2. Inspect the preview before any LLM review. If protected paths such as
+   `journal.db`, credentials, logs, or caller-provided protected paths are
+   reviewable, return `BLOCKED` and do not continue.
+3. Run `ocr delegate rule` only for the previewed paths. Pass the grouped rules
+   and exact diff to the root-owned Codex review. Capture the preview and rule
+   outputs as review artifacts. That review returns `PASS`, `NEEDS_FIX`, or
+   `BLOCKED` with findings, paths, lines, and checks.
+4. `NEEDS_FIX` consumes the single retry budget and requeues the owning coding
+   task; `BLOCKED` fails closed. Only `PASS` unlocks `review-sol-medium`.
+5. The OCR delegate path is read-only scope/rule discovery. Do not enable OCR
+   MCP or allow the gate to mutate files; fixes happen only through the normal
+   bounded coding handoff after an approved `NEEDS_FIX`.

## Root-owned route
@@ -35,9 +90,12 @@
  `BLOCKED` or exhausted retries fail closed. Do not open REVIEW until every
  planned task has a `PASS` handoff.
-6. Spawn the configured `review-sol-medium` reviewer only after all tasks pass.
-   A reviewer `PASS` is required before `synthesizer` may run. Reviewer
-   `NEEDS_FIX` uses the remaining retry and returns to work; `BLOCKED` ends the
-   workflow. Synthesis with a non-empty output is the only path to `DONE`.
+6. After all tasks pass, complete the OCR delegate review gate when the root
+   selected it for L2 code work. Then spawn the configured `review-sol-medium`
+   reviewer; without an OCR path, spawn it directly. A reviewer `PASS` is
+   required before `synthesizer` may run. Reviewer `NEEDS_FIX` uses the
+   remaining retry and returns to work; `BLOCKED` ends the workflow. Synthesis
+   with a non-empty output is the only path to `DONE`.
```
