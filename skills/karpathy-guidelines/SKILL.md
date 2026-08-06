---
name: karpathy-guidelines
description: >
  Behavioral guardrails for coding tasks: surface assumptions, choose the
  simplest sufficient implementation, make surgical changes, and define and
  run verifiable success checks. Use when writing, debugging, reviewing,
  refactoring, testing, or designing code; pair with ponytail for minimal,
  fast, precise execution.
---

# Karpathy Coding Guidelines

Apply these rules to coding work. `ponytail` remains the minimality filter;
this skill supplies the reasoning and verification guardrails.

## 1. Think before coding

- State the relevant assumptions before editing.
- If the request has materially different interpretations, name them and ask
  instead of silently choosing.
- Trace the actual code path and callers before changing a shared function.
- Push back on needless features or a safer simpler alternative; do not hide
  uncertainty.

For trivial, unambiguous one-line work, use judgment and keep this check brief.

## 2. Simplicity first

- Implement only the requested behavior; no speculative features,
  configuration, or abstractions.
- Reuse the existing project pattern and standard library before adding code or
  dependencies.
- Prefer the smallest correct diff, but never remove validation, security,
  error handling, accessibility, or other explicit requirements.
- If complexity is deliberately deferred, state the concrete trigger that would
  justify adding it later.

## 3. Surgical changes

- Touch only files and lines required by the request.
- Preserve existing style; do not reformat, rename, refactor, or rewrite
  adjacent code.
- Remove only imports, variables, or helpers made unused by your own change.
- Mention unrelated issues without fixing them unless requested.
- Every changed line must trace to the request or to making the requested
  change compile and pass its checks.

## 4. Goal-driven execution

Convert the request into a short success contract:

1. State the behavior that must hold.
2. Add or identify the smallest check that would fail before the fix when
   practical.
3. Implement the minimum change.
4. Run the focused check, then the relevant regression check.
5. Report what was verified and any unverified assumption or remaining blocker.

For multi-step work, write each step as `change → verify`. A vague goal such as
“make it work” is not acceptance evidence.

## Pairing with ponytail

- Use `ponytail` at its default `full` intensity for coding tasks unless the
  user selects another level or says `stop ponytail`/`normal mode`.
- Let this skill prevent wrong assumptions and unverified edits; let `ponytail`
  remove unnecessary work.
- Do not let minimality override trust-boundary validation, security, data-loss
  protection, accessibility, or explicit requirements.

## Output

Lead with the result. Include a compact summary of changed files, checks run,
and anything intentionally skipped or still needing input. Avoid a feature
tour.
