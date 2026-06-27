# Change: Apply and verify the requested alert condition in `alert_create`

## Why
`alert_create` advertises a `condition` choice (`crossing`, `greater_than`, `less_than`) but
`alerts.create()` (`src/core/alerts.js:19-88`) never applies it: it opens the dialog, sets the price and
message, clicks **Create**, and then echoes the requested `condition` straight back into the result
(`src/core/alerts.js:87`). The created alert therefore uses whatever condition TradingView had
pre-selected, while the caller is told `success: true` with the condition they asked for — a silent
wrong-condition alert with no signal to the caller (A3 S-2, A5 S-3).

This is the remaining behavioral half of audit finding S-3. The two adjacent halves are already owned by
other changes and are explicitly **out of scope** here:
- `harden-input-validation` constrains the `condition` schema to a `z.enum` (input shape).
- `normalize-failure-signaling` makes `create()` throw when the **Create** button is missing.
Neither makes the alert actually honor the requested condition, which is what this change adds.

## What Changes
- `alerts.create()` SHALL locate and set the alert condition control in the dialog to the requested
  `condition` **before** clicking Create.
- `alerts.create()` SHALL read back the condition the dialog actually holds and return that confirmed
  value, instead of echoing the requested string. The result SHALL distinguish the requested condition
  (`condition_requested`) from the confirmed condition (`condition`).
- If the condition control cannot be located, the requested condition is not offered, or the read-back
  does not match, `alerts.create()` SHALL fail (`success:false`/throw) rather than create an alert with
  an unverified condition — so the caller never receives `success:true` for a condition that was not
  applied.
- The `condition` echo in the success payload (`src/core/alerts.js:87`) SHALL be replaced by the
  verified value; `source` SHALL reflect that the condition was applied (`'applied'`, not the current
  `'dom_fallback'`).
- **Enum re-aligned to the real UI (spike outcome).** The discovery spike found the redesigned
  TradingView alert dialog offers only `Crossing` / `Crossing Up` / `Crossing Down` for a price alert —
  there is no "Greater Than"/"Less Than". The `condition` enum is therefore changed from
  `crossing`/`greater_than`/`less_than` to `crossing`/`crossing_up`/`crossing_down`
  (`src/tools/alerts.js`, `src/cli/commands/alerts.js`). See `design.md` §0.

### Prerequisite fixes uncovered by the spike (necessary for the condition step to function)
The spike proved the existing `create()` is non-functional against the current TradingView build, which
the condition logic depends on. These are fixed as part of this change:
- **Dialog open**: the header `[aria-label="Create Alert"]` selector is wrong-cased (the real attribute
  is lowercase `"Create alert"`) and opens the side panel; page-side clicks don't drive it. `create()`
  now opens via right-click chart → "Add alert on …" context-menu row (real CDP mouse), with Alt+A
  fallback.
- **Trusted input**: the dialog's operator dropdown only honours trusted CDP mouse events, so condition
  selection and Create are driven with real mouse, not page-side `.click()`.
- **Price field**: the old `[class*="alert"] input` selector matches nothing in the hashed-class dialog;
  `create()` now targets the dialog's visible value input.

## Impact
- Affected specs: `alert-management` (new capability)
- Affected code: `src/core/alerts.js` (open/condition/price/verify), `src/tools/alerts.js` +
  `src/cli/commands/alerts.js` (enum), `tests/alerts.test.js` (DI-mocked unit coverage),
  `tests/e2e.test.js` (live non-destructive condition assertion)
- Coordinates with: `normalize-failure-signaling` (the Create-button-missing throw is preserved). The
  enum change supersedes the `crossing`/`greater_than`/`less_than` shape from `harden-input-validation`.
