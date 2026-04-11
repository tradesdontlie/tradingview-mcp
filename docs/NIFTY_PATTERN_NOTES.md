# Nifty Pattern Notes

This note is the plain-English pattern readout from the current Nifty options-track work.

## What We Tested

- underlying signal candidate:
  - `mid_1315_thr050_vwap`
- data backbone:
  - Kite intraday index caches
  - official NSE derivative bhavcopy EOD option archive

## What Looks Good

- The directional Nifty signal itself is still usable as a research lead.
- A stricter threshold helped more than stacking many indicators.
- Proxy `VWAP` confirmation was one of the few filters that improved the charged Nifty futures-style proxy instead of making it worse.
- The live-paper Nifty option path can already reconstruct and journal same-day ATM option trades and companion debit spreads.

## What Looks Weak

- The first archived option overlay is negative when modeled as:
  - option entry at signal-day close
  - option exit at next available trade-day close

That is a useful warning:

- a correct directional intraday read does not automatically translate into profitable overnight naked ATM option carry
- time decay and post-event volatility changes can dominate

## Obvious Pattern Signals

From the current archived option overlay:

- very large signal days (`1.00%+`) are the weakest bucket
- Tuesdays are the weakest weekday in the currently available archived slice
- the better-looking use case is still intraday participation, not overnight option carry

## Practical Fixes Suggested By The Data

1. Keep the option track intraday-first.
   Do not treat overnight EOD option carry as the default vehicle.

2. Keep ATM option buys as the primary paper path for now.
   They are simpler and create less optimization surface than spreads.

3. Use debit spreads as a secondary overlay, especially on days where:
   - the move is already very large
   - or we want to cap premium and volatility exposure

4. Treat extreme signal days as a separate regime.
   A huge move in the underlying can still be a bad option-buy if the premium is already inflated.

5. Do not over-read the current EOD archive overlay.
   It is useful for historical structure and regime detection, but it is not the same thing as an exact intraday option backtest.

## What Is Implemented Now

- The live paper runner keeps `ATM option` as the primary vehicle.
- The debit spread remains a secondary companion overlay.
- The runner now surfaces archive caution flags on:
  - `1.00%+` signal days
  - Tuesdays

These are intentionally warnings, not hard filters, because the archive slice is still limited and EOD-based.

## Biggest Missing Piece

We still need richer historical option bar data to answer the real question:

- if the signal fires intraday, what would the ATM option or debit spread have done intraday after realistic execution and charges?

Until that exists, the cleanest live path is:

- use the validated underlying signal engine
- keep option execution in paper mode
- compare ATM buys vs debit spreads in forward observation
