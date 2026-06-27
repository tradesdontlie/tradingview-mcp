---
name: chart-export
description: Export the current TradingView chart as a PNG via the MCP. Use when the user says "export the chart", "screenshot the chart", "grab a png", "save the chart as an image", "export all the panes", "capture the indicators", "snapshot TradingView", or wants a chart image saved to a specific location. Covers region selection (price pane vs full window vs strategy tester), dismissing dialogs, choosing zoom/symbol before the shot, and copying the result out of the auto-pruned screenshots folder.
---

# Chart Export (MCP screenshot)

Exports the live TradingView chart to a PNG using the MCP's screenshot capability.

## ⚠️ The one thing to understand first

**The MCP takes a photograph of the live TradingView window exactly as it is on screen right now.** It does **not** render anything off-screen, re-lay-out the chart, or compose panes that aren't displayed. Under the hood it's a Chrome DevTools `Page.captureScreenshot` of the rendered DOM, with `region` only *cropping* the result.

Practical consequence — **what you see is what you get.** Before capturing, make sure the window already shows what you want:

- **Right symbol & timeframe** loaded (only the *active tab* is captured).
- **Right zoom / visible range** — the shot reflects the current scroll position and zoom.
- **The panes you want are visible** — indicator sub-panes (MarketCipher_B, RSI, etc.) are *separate stacked panes*; they appear only in a `full` capture, never in a `chart` capture.
- **No popups/dialogs in the way** — alert dialogs and indicator alert pop-ups (e.g. MarketCipher) will show up in the image unless dismissed first.
- **The window is restored, not minimized** — a minimized Electron window may not paint, producing a blank or stale frame.

Always tell the user this when they ask to export: *"This captures the live window as it's currently displayed, so I'll set the symbol/timeframe/zoom and dismiss any dialogs before shooting."*

## Region cheat-sheet

| `region` | What you get | Use for |
|---|---|---|
| `chart` | **Price pane only** (clipped to the main `pane-canvas`). Sub-panes and UI chrome are cropped out. | A clean candles-only image. |
| `full` | **The whole window** — every stacked pane (price + volume + all indicator panes) **plus** the left toolbar, top toolbar, and any open right-side panel (Alerts / Watchlist). | Exporting the candles *and* the indicators (MarketCipher, RSI) together. |
| `strategy_tester` | The backtesting/strategy-report panel. | Exporting strategy results. |

There is **no per-sub-pane region.** To isolate just the MarketCipher or RSI pane, capture `full` and crop the PNG afterward (see Step 5), or temporarily hide the other panes.

## Step 1 — Verify the connection

```bash
node src/bin.js cli status
```

If `cdp_connected: false`, stop and use the `launch-tradingview` skill — there's nothing to photograph until TradingView is up.

## Step 2 — Stage the window (this is where export quality is won or lost)

Set up exactly what should appear in the frame **before** shooting:

1. **Symbol / timeframe** (only if the user wants a different one than what's loaded):
   - `chart_set_symbol`, `chart_set_timeframe`
   - To export a *different* chart that's open in another tab, switch first: `tab_list` → `tab_switch`. The capture only ever sees the active tab.
2. **Zoom / framing** — set the visible window so the relevant price action fills the frame:
   - `chart_set_visible_range` (exact unix range) or `chart_scroll_to_date` (jump to a date).
   - Check with `chart_get_visible_range` if unsure what's on screen.
3. **Make sure the wanted panes are visible** — confirm with `chart_get_state` that the indicators you want are present. If a pane is collapsed/hidden it won't appear.
4. **Dismiss any open dialog or alert pop-up** — this is the most common cause of a ruined export:
   ```bash
   node src/bin.js cli ui keyboard --key Escape
   ```
   (Indicator alert dialogs — MarketCipher especially — pop open on their own and will sit in the middle of your image.)
5. **For a clean `full` shot, close side panels** so the chrome doesn't dominate the image:
   - `ui_open_panel` toggles the alerts/watchlist/etc. panels closed.

## Step 3 — Capture

Pick the region from the cheat-sheet and give it a meaningful filename (no extension — `.png` is added; the name is sanitized to alphanumeric/`._-`).

```bash
# Whole window incl. all indicator panes:
node src/bin.js cli screenshot -r full -o BTC-full-2026-06-27

# Just the candles:
node src/bin.js cli screenshot -r chart -o BTC-price-2026-06-27
```

MCP-tool equivalent: `capture_screenshot` with `{ region, filename }`. Extra MCP-only options:
- `method`: `cdp` (default — writes a PNG and returns its path) or `api` (fires TradingView's own `takeScreenshot()`, which hands off to TV's native save/share UI and returns **no file path** — avoid unless the user specifically wants TV's own export).
- `persist: false` — deletes the artifact right after returning its path/size (use when you only need the bytes via the return, not a kept file).
- `max_files` / `max_age_days` / `max_bytes` — override the retention pruning for this call.

The call returns a `file_path` and `size_bytes` — **not** the image data — to keep the LLM context small.

## Step 4 — View / confirm

`Read` the returned `file_path` with the Read tool to actually see the image and confirm it framed correctly (right symbol, no dialog in the way, all wanted panes present). If something's off, fix the staging in Step 2 and re-shoot — don't ship a bad frame.

## Step 5 — Deliver to the user

The screenshot lands in the package's `screenshots/` folder, which **auto-prunes** (default: keep 50 files / 7 days). So **copy anything the user wants to keep to a stable location** they named (e.g. `C:\temp`):

```powershell
Copy-Item '<returned file_path>' 'C:\temp\<name>.png' -Force
```

To **isolate a single sub-pane** (e.g. just MarketCipher or just RSI) from a `full` shot, crop with .NET imaging in PowerShell — no TradingView interaction needed:

```powershell
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('C:\temp\BTC-full.png')
# (x, y, width, height) of the pane within the full image — read the coords off the Step-4 image
$rect = New-Object System.Drawing.Rectangle 0, 540, 1520, 200
$crop = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0,0,$rect.Width,$rect.Height), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$crop.Save('C:\temp\BTC-marketcipher.png'); $g.Dispose(); $crop.Dispose(); $src.Dispose()
```

If the user wants the file surfaced directly in chat, use `SendUserFile` with the saved path.

## Best-practices summary (tell the user when relevant)

- **It's a live snapshot** — the export mirrors the on-screen window; stage symbol/timeframe/zoom/panes and dismiss dialogs *before* shooting.
- **`chart` = price only, `full` = everything (panes + chrome).** If the user wants candles *and* indicators, use `full`.
- **Close side panels** before a `full` shot for a clean image, or expect the Alerts/Watchlist chrome in the frame.
- **`screenshots/` is temporary** — copy keepers to a named, stable path.
- **Use `cdp` (default), not `api`** — only `cdp` returns a usable file path.

## Pitfalls

- **Sub-panes missing?** You used `region: chart`. Use `full`.
- **A dialog is in the image?** You skipped the Escape in Step 2.
- **Wrong symbol exported?** You captured a different active tab — `tab_switch` first.
- **Blank/stale image?** The window was minimized; restore it and re-shoot.
- **`api` method returned no path?** That's expected — switch to `cdp`.
- **File vanished later?** Retention pruned it — copy keepers out of `screenshots/` immediately (Step 5).
