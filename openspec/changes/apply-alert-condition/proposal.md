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
  `condition` (`crossing`/`greater_than`/`less_than`) **before** clicking Create.
- `alerts.create()` SHALL read back the condition the dialog actually holds and return that confirmed
  value, instead of echoing the requested string. The result SHALL distinguish the requested condition
  from the confirmed condition.
- If the condition control cannot be located or the requested condition cannot be selected,
  `alerts.create()` SHALL fail (`success:false`/throw) rather than create an alert with an unverified
  condition — so the caller never receives `success:true` for a condition that was not applied.
- The `condition` echo in the success payload (`src/core/alerts.js:87`) SHALL be replaced by the
  verified value; `source` SHALL reflect that the condition was applied (not the current
  `dom_fallback`-only signal).

## Impact
- Affected specs: `alert-management` (new capability)
- Affected code: `src/core/alerts.js`, `tests/` (DI-mocked unit coverage for the condition path;
  `e2e.test.js` alert assertions)
- Depends on / coordinates with: `harden-input-validation` (enum), `normalize-failure-signaling`
  (Create-button throw). No overlapping requirements.
