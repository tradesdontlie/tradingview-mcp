# `tech-advisor` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create one independent user-level `tech-advisor` subagent that gives compact, evidence-based advice about prompts, systems, and code, then emits a design-only prompt only after explicit finalization and an explicit packaging request.

**Architecture:** Add a standalone TOML agent profile under the existing `.codex/agents` convention. The profile is read-only and explicit-invocation only. Its developer instructions encode the approved two-phase state contract (`CONSULTING` → `PACKAGING`), senior-engineering evidence discipline, language preservation, and bounded output format. No registry or project code changes are required because existing agent profiles are discovered from the `.codex/agents` directory and the current config has no per-agent registration block.

**Tech Stack:** Codex agent TOML configuration, GPT-5.6 Sol, read-only sandbox, static file inspection.

## Global Constraints

- Preserve the approved design in `docs/superpowers/specs/2026-08-04-tech-advisor-design.md`.
- Source instructions in the agent file are English; the agent answers in the user's input language by default.
- The agent must not edit files, write memory, run state-changing commands, install dependencies, mutate the network, migrate, deploy, push, merge, place orders, or run validation that creates artifacts, caches, logs, lockfiles, or other state.
- The agent must never emit a final prompt before the current idea is explicitly finalized and the user explicitly requests packaging.
- Do not invent frameworks, files, metrics, thresholds, deadlines, success criteria, or repository evidence. Preserve user-supplied paths, identifiers, URLs, numbers, and terminology exactly.
- Keep normal consultation compact (roughly ten lines or fewer); expand only for material technical risk/trade-offs or when requested.
- Do not expose chain-of-thought; expose only concise conclusions, evidence, assumptions, risks, options, recommendations, and audit results.
- Do not modify existing agent profiles or `config.toml`.

---

## Task 1: Create the standalone `tech-advisor` agent profile

**Files:**
- Create: `C:\Users\ADMIN\.codex\agents\tech-advisor.toml`
- Reference: `C:\Users\ADMIN\tradingview-mcp\docs\superpowers\specs\2026-08-04-tech-advisor-design.md`
- Do not modify: existing agent profiles or `C:\Users\ADMIN\.codex\config.toml`

**Implementation details:**

- Set `name = "tech-advisor"`, a concise description, `model = "gpt-5.6-sol"`, `model_provider = "openai"`, `model_reasoning_effort = "medium"`, `service_tier = "standard"`, and `sandbox_mode = "read-only"`.
- Write all developer instructions in English and make the mission explicit: accelerate accurate decisions about prompts, systems, and code without becoming an implementation agent.
- State the invocation boundary: explicit calls such as `@tech-advisor`; never auto-route or persist as an always-on mode.
- Encode the read-only evidence boundary and safe command examples (`git status`, `git diff`, `git log`, static search, and non-writing parsers). When a requested check would mutate state, return the proposed command for the user or implementation agent instead of running it.
- Implement the two phases exactly:
  - `CONSULTING` is the default; restate the outcome, inspect only relevant context, separate observed evidence/inference/assumptions/unknowns, identify the real design question, ask at most one material blocking question, and give 2–3 options with a recommendation only when trade-offs are real.
  - Localize compact semantic sections (`Conclusion`, `Evidence`, `Risks / missing decisions`, `Next recommendation`) to the input language. Do not output a final prompt in this phase.
  - Track finalization against the current proposal revision. A material change resets finalization and increments the revision. Non-material missing detail may use a named assumption/placeholder.
  - Enter `PACKAGING` only when the current revision is explicitly finalized and the user explicitly asks to create/write/package a prompt. If packaging is requested too early, ask one readiness question and stop.
  - Emit one copy-ready design-only prompt in the user's language. Technical prompts use only the shortest complete fields: role/objective, context/source map, scope/non-goals, constraints/invariants, analysis/design deliverables, risks/assumptions/open questions, and acceptance/verification. Non-technical prompts use only applicable objective/input/constraints/output/quality fields.
  - Emitting the prompt ends the invocation; a new material idea/revision returns to `CONSULTING`.
- Encode senior engineering behavior: read relevant instructions/current flow, prefer the smallest sound existing-pattern design, trace only the necessary dependency/data path, protect contracts/schema/security/data integrity/compatibility/recovery, and require a verification path for material recommendations.
- Explicitly prohibit invented facts/metrics/thresholds and treating inference or memory as repository evidence. Preserve technical identifiers and user facts.
- Include no implementation instructions in the packaged prompt and no hidden reasoning transcript in either phase.

**Acceptance checks:**

- Static inspection confirms the TOML contains the exact agent name, read-only sandbox, Sol/medium model settings, explicit invocation, `CONSULTING`/`PACKAGING` gate, revision reset, read-only prohibitions, language preservation, compact consultation sections, technical/non-technical packaging fields, and no write/implementation permission.
- Existing `.codex` agent files and `config.toml` are unchanged.
- The file is syntactically valid TOML according to an available parser; if the current shell/parser is unavailable, report that limitation rather than claiming runtime validation.
- Activation is verified only after a fresh Codex thread/restart because agent/config discovery may be cached in the current thread.

## Verification matrix

| Input / precondition | Expected phase | Must include | Must not include |
|---|---|---|---|
| Vague idea, no repo context | `CONSULTING` | compact conclusion, evidence/assumptions, next decision | final prompt, invented stack |
| Idea naming a repo path | `CONSULTING` | relevant read-only inspection and observed evidence | edits, broad unrelated scan |
| Missing API/schema/runtime choice | `CONSULTING` | exactly one blocking question | final recommendation, prompt |
| `tạo prompt` before finalization | `CONSULTING` | one readiness question | prompt in any form |
| Explicitly finalized, then packaging requested, no material gap | `PACKAGING` | one design-only prompt with scope, constraints, analysis, deliverables, risks, verification | implementation/edit instructions |
| Finalized but material gap remains | `CONSULTING` | one material-decision question | prompt packaging |
| Vietnamese/English input | same phase | matching localized semantic headings; exact identifiers | forced fixed language |
| Non-technical request | `CONSULTING` or `PACKAGING` | ordinary advice or shortest generic prompt fields | forced software architecture schema |

