# Windows: TradingView Desktop is MSIX, and cannot take the debug flag

On Windows, TradingView ships **only** as an MSIX package:

```
https://tvd-packages.tradingview.com/stable/latest/win32/TradingView.msix
```

There is no standalone `.exe` or `.msi`. It installs to:

```
C:\Program Files\WindowsApps\TradingView.Desktop_<version>_x64__<hash>\
```

`WindowsApps` is ACL-protected. The result is that **no method of starting the
Desktop app with `--remote-debugging-port` works**, so `tv launch` cannot bring
up a CDP endpoint from the Store build.

This is structural, not a misconfiguration. Use Chrome instead — see below.

## What was tried, and how each fails

| Attempt | Result |
| --- | --- |
| `Start-Process` the exe inside `WindowsApps` with the flag | `Access is denied` / `spawn EPERM` |
| Launch via the app's AUMID (`shell:appsFolder\...`) | Starts, but Store activation accepts no command-line flags, so the port never binds |
| Launch while an instance is already running | Single-instance handoff: the new process exits and the flag never applies |
| Copy the ~335 MB package to `%LOCALAPPDATA%` and run it from there | Binds the port, then aborts: `FATAL: GPU process isn't usable. Goodbye.` |
| The same copy with `--disable-gpu --disable-gpu-sandbox --in-process-gpu` | Runs, but outside the package it gets a **fresh profile**: a welcome dialog, an "Oops, something went wrong" page, and `chart_symbol: unknown`, `api_available: false` |

The copy-out approach is worth calling out because it is the one the code
attempts as a fallback. Even when forced past the GPU crash, an MSIX Electron
app run outside its package loses package identity and its user data, so it is
not signed in and never reaches a chart.

If you try it, **delete the copy afterwards**. `launch` looks for exactly that
cache path and will prefer the broken copy over the real installation.

## What works: point CDP at Chrome

This tool reads the TradingView **web app's** JavaScript API:

```js
window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries()
```

The Desktop app is Electron wrapping that same web app, so those objects exist
in ordinary Chrome on a `tradingview.com/chart/` page. Pointing CDP at Chrome
gives `cdp_connected: true`, `api_available: true`, and full chart control
against the same objects the tool already targets.

```
"C:\Program Files\Google\Chrome\Application\chrome.exe"
  --remote-debugging-port=9222
  --user-data-dir="%LOCALAPPDATA%\tv-debug-profile"
  https://www.tradingview.com/chart/
```

The dedicated `--user-data-dir` is **required, not cosmetic**: Chrome ignores
`--remote-debugging-port` if it can hand off to an already-running instance on
the default profile. A separate profile also keeps the debug-enabled browser
isolated from normal browsing, and it persists the TradingView login, so signing
in is a one-time step.

### Checklist

1. Start Chrome with the flags above.
2. Make sure a **chart** is loaded at `tradingview.com/chart/`. The tool looks
   for a chart target specifically, not the homepage.
3. Verify:

```bash
tv status
```

Expect `"cdp_connected": true` with a `chart_symbol` and `api_available: true`.

If it reports `No TradingView chart target found`, CDP is reachable but no chart
page is open. Navigate to a chart; nothing needs restarting.

### If commands hang rather than fail

A Chrome tab whose renderer has died still appears in `/json/list`, and CDP will
connect to it, but every `Runtime.evaluate` blocks forever, so every tool call
hangs. The giveaway is a page title frozen at a stale price while
`Page.getNavigationHistory` still answers, because that is served by the browser
process rather than the page.

Close the dead tab and open a fresh chart tab. Restarting TradingView Desktop
will not help, since the endpoint is Chrome.

## Security note

Anything that can reach port 9222 controls that browser as whoever is signed in
to it. Sign in to **TradingView only** in this profile, and do not sign in to
Chrome itself. If you do not need chart access continuously, start the profile
when you need it rather than at login.
