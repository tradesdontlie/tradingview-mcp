## 0. Discovery spike — capture the real dialog DOM
- [ ] 0.1 Against a live TradingView chart, open the alert-create dialog and capture the actual condition
      control: its DOM shape (dropdown vs. segmented control vs. native `<select>`), the stable selector
      (`data-name`/`aria-label`/role), and the exact option label text for each of `crossing` /
      `greater_than` / `less_than` (e.g. "Crossing", "Greater Than", "Less Than" — confirm the real
      strings, including any "Crossing Up"/"Crossing Down" split). Record whether the field set
      re-renders when the condition changes (to size the settle delay in 1.2).
- [ ] 0.2 Record the read-back path used in section 2 (how the dialog exposes the currently-selected
      condition) so the verify step targets a real attribute, not an assumed one. Park the captured
      selectors/labels in `design.md` (add one if the spike surfaces non-trivial decisions) before
      writing the section 1–3 implementation against them.

## 1. Apply the requested condition
- [ ] 1.1 In `src/core/alerts.js` `create()`, after the dialog opens and before clicking Create, add a
      DOM step that locates the condition control (dropdown/segmented control) in the alert dialog and
      selects the option matching the requested `condition`. Map `crossing`/`greater_than`/`less_than`
      to the dialog's option labels ("Crossing", "Greater Than", "Less Than" / "Crossing Up"/"Crossing
      Down" as the UI exposes them). Interpolate any selector/label values through `safeString()`.
- [ ] 1.2 Add a named constant for any settle delay introduced by changing the condition (the dialog can
      re-render its field set when the condition changes), following the existing
      `ALERT_DIALOG_OPEN_MS`/`ALERT_FIELDS_SETTLE_MS` pattern rather than a bare literal.

## 2. Verify and report the condition
- [ ] 2.1 After selecting (and before/after Create as appropriate), read back the condition the dialog
      actually holds.
- [ ] 2.2 Replace the echoed `condition` in the success payload (`src/core/alerts.js:87`) with the
      verified value. Return both the requested and confirmed condition (e.g.
      `condition_requested` + `condition` = confirmed) so they are distinguishable. Update `source` to
      reflect that the condition was applied.

## 3. Fail when the condition cannot be applied
- [ ] 3.1 When the condition control cannot be found or the requested option cannot be selected, fail
      with a clear error ("Could not apply alert condition '<x>'") instead of proceeding to Create.
      Keep this distinct from the existing Create-button-missing failure owned by
      `normalize-failure-signaling`.

## 4. Tests
- [ ] 4.1 DI-mocked unit test: inject `_deps.evaluate` so the condition-select step is exercised — assert
      `create()` issues the condition-selection evaluate and that the returned payload reports the
      confirmed (read-back) condition, not a blind echo.
- [ ] 4.2 DI-mocked unit test: when the injected condition-select/read-back resolves "not found",
      `create()` fails (`success:false`/throws) and does not report success.
- [ ] 4.3 Update `tests/e2e.test.js` alert coverage so it asserts the created alert carries the
      requested condition (the current test only checks that the alert button exists).

## 5. Validate
- [ ] 5.1 `openspec validate apply-alert-condition --strict`
