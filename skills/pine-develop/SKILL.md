---
name: pine-develop
description: Full Pine Script development loop — write code, compile, fix errors, iterate. Use when building a new indicator or strategy in TradingView.
---

# Pine Script Development Loop

You are developing a Pine Script indicator or strategy in TradingView. Follow this loop precisely.

## Step 1: Understand the Goal

If not already clear, ask the user:
- What type? (indicator, strategy, library)
- What does it do? (entry/exit logic, overlay, oscillator, etc.)
- Overlay or separate pane?
- Any specific inputs or visual elements?

## Step 2: Pull Current Source (if modifying)

If modifying an existing script:
```bash
node scripts/pine_pull.js
```
Then read `scripts/current.pine` to understand what's there.

If creating new: start from scratch.

## Step 3: Write the Pine Script

Write the complete script to `scripts/current.pine`. Every script MUST include:
- `//@version=6` header
- Proper `indicator()` or `strategy()` declaration
- All user inputs with `input.*()` functions and groups
- Clear comments for each logical section

For strategies, include:
- `strategy.entry()` and `strategy.exit()` calls
- Position sizing via `strategy()` declaration
- Default commission and slippage settings

## Step 4: Push and Compile

### Audit C2 preflight (mandatory before pine_deploy_*)

Before deploying, call `pine_get_editor_state` to verify the editor is
NOT bound to a different saved script:

```
pine_get_editor_state()
  → { script_name: <bound_name_or_null>, dirty, action_button, modal }
```

If `script_name` is set AND differs from your script's name, either:
- Call `pine_new(type='indicator')` to clear the editor, OR
- Pass `force_overwrite_editor:true` on the deploy.

Without this preflight, `pine_deploy_*` will refuse with
`code:"EDITOR_HOLDS_DIFFERENT_SAVED_SCRIPT"` (audit C2/A1-F5/A2-F2).

### Audit C10 lint (mandatory before deploy)

Always `pine_lint(source=...)` BEFORE `pine_deploy_*`. Look for
`v6-multi-line-plus` errors — Pine v6 does not support implicit line
continuation across the `+` operator. Wrap the offending expression in
`(` ... `)`.

### Then deploy

```bash
node scripts/pine_push.js
```

This injects the code into TradingView's Pine Editor, clicks compile, and reports any errors.

### Audit C8 — deploy failure diagnosis

If the response is `success:false`, ALWAYS read `step_failed` +
`ui_diagnostic` FIRST. The diagnostic tells you whether the modal needs
dismissing, the source needs fixing, or the panel needs re-opening.
Common cases:
- `step_failed:"set_source"` → editor panel closed. Call `pine_new()`.
- `step_failed:"add_to_chart_button_click"` + `blocking_modal_open:true`
  → call `pine_dismiss_dialog({accept:true, expected_dialog_kinds:["save_and_add_to_chart"]})`
  (audit C7/A1-F7).
- `step_failed:"study_added"` + non-empty `compile_errors` →  fix the
  source per the listed errors.

## Step 5: Fix Errors

If errors are reported:
1. Read the error messages (line number + description)
2. Edit `scripts/current.pine` locally — fix the specific lines
3. Push again: `node scripts/pine_push.js`
4. Repeat until 0 errors

Common Pine Script errors:
- **"Mismatched input"** — usually indentation (Pine uses 4-space indentation, not braces)
- **"Could not find function or function reference"** — typo in function name or wrong version
- **"Undeclared identifier"** — variable used before declaration
- **"Cannot call X with argument type Y"** — wrong parameter type

## Step 6: Verify on Chart

After clean compilation:
1. `capture_screenshot` — take a screenshot to verify it looks right
2. `data_get_strategy_results` — if it's a strategy, check performance
3. Show the user the results

## Step 7: Iterate

If the user wants changes:
1. Pull fresh: `node scripts/pine_pull.js` (in case TV modified anything)
2. Edit locally
3. Push + compile
4. Screenshot to verify

IMPORTANT: Always compile after every change. Never claim "done" without a clean compile.
