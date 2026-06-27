# Design — Apply and verify the alert condition

## 0. Discovery spike findings (captured against live TradingView Desktop, BTCUSDT 1D, CDP 9222)

The redesigned (2025/2026) alert dialog uses **hashed CSS-module class names** with no `data-name` or
`aria-label` anchors on the condition controls. Selectors must therefore match on **structure + visible
text**, not on class — class suffixes (`-Q92ASNAn`, `-sFcMHof4`, `-qyCw0PaN`) change every TV build.

### Opening the dialog
The header **Create alert** control (`[aria-label="Create alert"]`, lowercase `a` — the current
`create()` uses `"Create Alert"` with a capital `A`, which is **wrong** and opens the side panel instead
of the dialog) is unreliable. The robust, observed-working path:

1. Right-click the chart price pane (real CDP `mousePressed/Released` with `button:'right'`).
2. In the context menu, click the row whose text matches `/^Add alert on/i` (a `<tr>`); it carries the
   `Alt + A` shortcut hint. This opens the **same** create-alert dialog and pre-seeds Price-crossing-Value.

The dialog container is `div.dialog-qyCw0PaN …` (text begins `"Create alert on <SYMBOL>"`). The
condition block: `div[class*="condition"]` › `fieldset[class*="container"]` › `div[class*="fieldsWrapper"]`
(reads `"Price" | "<operator>" | "<value>"`).

### Condition (operator) control
- **Control**: the first **visible** `[class*="operatorRow"]`. Its `textContent` is the current operator
  label (the read-back path — see §2).
- **Open the dropdown**: real-click the operatorRow center.
- **Options**: `[role="option"]` elements; the selected one carries `aria-selected="true"`. Click the
  option whose trimmed `textContent` equals the target label.
- **Settle**: selecting an option re-renders the field set; an ~700ms settle was reliable in the spike.

### Available operator labels — IMPORTANT scope finding
For a **Price** condition (price vs. a constant value), this build offers **only three** operators:

| label          | semantics                          |
|----------------|------------------------------------|
| `Crossing`     | fires once when price touches level |
| `Crossing Up`  | fires once crossing upward          |
| `Crossing Down`| fires once crossing downward        |

There is **no "Greater Than" / "Less Than"** in this dialog (confirmed: only 3 `[role="option"]`
entries, no virtualized overflow, no scroll, no "show more" inside the operator dropdown). The
`alert_create` `condition` enum advertised `crossing` / `greater_than` / `less_than`; two of those three
values have **no corresponding option** in the current UI.

### Read-back (§2 verify)
After selecting and after closing the dropdown, re-read the `[class*="operatorRow"]` `textContent`; it
reflects the chosen label (validated: `"Crossing"` → select Crossing Up → reads `"Crossing Up"`).
Equivalently, while the dropdown is open, the chosen `[role="option"][aria-selected="true"]` carries the
label. The verify step targets this real text, not an assumed attribute.

### Create / Cancel
Buttons are matched by trimmed `textContent` (`"Create"` / `"Cancel"`); no stable data-name. The whole
apply→verify→cancel cycle was exercised live without creating an alert.

## Decision — condition label mapping

Given the spike, the `condition` → dialog-label map is:

```
crossing      -> "Crossing"
crossing_up   -> "Crossing Up"     (newly exposed by the real UI)
crossing_down -> "Crossing Down"
greater_than  -> (no option in this build)
less_than     -> (no option in this build)
```

`greater_than` / `less_than` are **not silently remapped** to a crossing variant (that would reintroduce
the exact silent-wrong-condition bug this change exists to kill — "Crossing Up" fires once on the cross,
not whenever price is above). Instead they take the **§3 fail-loud path**: when the requested condition
has no matching `[role="option"]` in the dialog, `create()` throws
`Could not apply alert condition '<x>' (not offered by this TradingView build; available: Crossing,
Crossing Up, Crossing Down)` and does **not** click Create. This keeps the contract honest: a condition
the UI cannot express never yields `success:true`.

> Resolved: the user chose (a) — extend the enum to `crossing`/`crossing_up`/`crossing_down` and drop
> `greater_than`/`less_than`. Implemented in `src/tools/alerts.js` + `src/cli/commands/alerts.js`.

## §1b — Price field also needs trusted keyboard input (live smoke finding)

A real create-then-delete smoke test (production `core.create()`, not a probe) surfaced a second silent
bug the Cancel-only e2e couldn't: the **condition applied correctly but the price did not**. The created
alert used the context-menu-seeded price (e.g. `84,174.29`), not the requested one, while the result
still reported `price_set:true`.

Root cause is the same trusted-event gap as the dropdown, one layer down: a native-setter `.value` write
plus a synthetic `input` event updates the visible field but **not** TradingView's internal alert model,
so Create reads the seeded value. Even `Input.insertText` alone wasn't enough — the model only commits on
**blur/Tab**. The fix (`typeIntoField`): real click to focus → Ctrl+A → `insertText` → **Tab to commit**,
then **read the value back and verify it equals the request before clicking Create** (throw
`Alert price not applied: …` otherwise, so a mis-set price fails loud *before* an alert exists).

Verified live: production `create({condition:'crossing_up', price:72500})` produced an alert
`"BTCUSDT Crossing Up 72,500.00"` (`cond:cross_up`), then cleaned up via the alerts-panel context menu.
(The `pricealerts` REST delete shape could not be reverse-engineered — `POST /delete_alerts` exists but
rejects every guessed body with `invalid_request`; `deleteAlerts()` still uses the UI path, unchanged.)
