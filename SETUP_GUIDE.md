# Setup Guide for Claude Code

This file is a step-by-step guide for Claude Code (or any LLM agent) to install and configure the TradingView MCP server. If a user asks you to install or set up this project, follow these steps exactly.

## Step 1: Clone and Install

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git ~/tradingview-mcp
cd ~/tradingview-mcp
npm install
```

If the user specifies a different install path, use that instead of `~/tradingview-mcp`.

## Step 2: Add to MCP Config

Add the server to the user's Claude Code MCP configuration. The config file is at `~/.claude/.mcp.json` (global) or `.mcp.json` (project-level).

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["<INSTALL_PATH>/src/server.js"]
    }
  }
}
```

Replace `<INSTALL_PATH>` with the actual path where the repo was cloned (e.g., `/Users/username/tradingview-mcp`).

If the config file already exists and has other servers, merge the `tradingview` entry into the existing `mcpServers` object. Do not overwrite other servers.

## Step 3: Launch TradingView Desktop

TradingView Desktop must be running with Chrome DevTools Protocol enabled.

**Auto-detect and launch (recommended):**
After the MCP server is connected, use the `tv_launch` tool — it auto-detects TradingView on Mac, Windows, and Linux.

**Manual launch by platform:**

Mac:
```bash
/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222
```

Windows:

TradingView for Windows now ships **only as an MSIX package** (Microsoft Store and tvd-packages.tradingview.com both install under `C:\Program Files\WindowsApps\`). Use the launch script — no admin rights needed:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\launch_tv_debug.ps1
```

It stops any running instance, COM-activates the package with the debug flag, and waits until the port actually binds before reporting success. `scripts\launch_tv_debug.vbs` is a double-clickable wrapper around the same script; `scripts\launch_tv_debug.bat` remains for legacy non-MSIX installs.

**Why a dedicated launcher is needed.** An MSIX app under `WindowsApps` cannot be started with command-line arguments the usual ways:

| Approach | Result |
|----------|--------|
| Run the exe directly | **Access is denied** — those ACLs allow execution only via package activation |
| `explorer.exe shell:AppsFolder\...` | Activates, but provides no way to pass arguments |
| `Invoke-CommandInDesktopPackage` | **ERROR_CANCELLED** (`0x800704C7`) on some builds, elevated or not |

`IApplicationActivationManager::ActivateApplication` is the one activation path that forwards an argument string to a `Windows.FullTrustApplication` exe. That call lives in `scripts\activate_msix.ps1`, which the launcher and `tv_launch` both use.

Note that a Start-menu launch produces a running chart with **no** debug port, which looks identical to a working one until a tool fails — so verify rather than assume:

```powershell
Get-NetTCPConnection -LocalPort 9222 -State Listen
```

Or, preferred: let the `tv_launch` MCP tool do it. It tries a direct spawn, then COM activation (`msix_activation: true` in the result), and finally — on Windows builds where activation accepts the flag but the port never binds — copies the package to `%LOCALAPPDATA%\tradingview-mcp\` (one-time, ~330MB) and launches from the copy (`msix_local_copy: true`). The copy keeps your login, layout, and chart state.

Manual equivalent of that fallback, if you need it:

```powershell
$pkg = (Get-AppxPackage TradingView.Desktop).InstallLocation
Copy-Item "$pkg\*" "$env:LOCALAPPDATA\tradingview-mcp\TradingView" -Recurse -Force
& "$env:LOCALAPPDATA\tradingview-mcp\TradingView\TradingView.exe" --remote-debugging-port=9222
```

Reading files out of `WindowsApps` by exact path is allowed even where executing them isn't. Do **not** try to change ACLs on `WindowsApps` with `icacls` — it fails and can break app servicing.

Legacy (pre-MSIX) installs:
```bash
%LOCALAPPDATA%\TradingView\TradingView.exe --remote-debugging-port=9222
```

Linux:
```bash
/opt/TradingView/tradingview --remote-debugging-port=9222
# or: tradingview --remote-debugging-port=9222
```

## Step 4: Restart Claude Code

The MCP server only loads when Claude Code starts. After adding the config:

1. Exit Claude Code (Ctrl+C)
2. Relaunch Claude Code
3. The tradingview MCP server should connect automatically

## Step 5: Verify Connection

Use the `tv_health_check` tool. Expected response:

```json
{
  "success": true,
  "cdp_connected": true,
  "chart_symbol": "...",
  "api_available": true
}
```

If `cdp_connected: false`, TradingView is not running with `--remote-debugging-port=9222`.

## Step 6: Install CLI (Optional)

To use the `tv` CLI command globally:

```bash
cd ~/tradingview-mcp
npm link
```

Then `tv status`, `tv quote`, `tv pine compile`, etc. work from anywhere.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | Launch TradingView with `--remote-debugging-port=9222` |
| Windows: "Access is denied" launching from `WindowsApps` | Expected — use `scripts\launch_tv_debug.ps1` or `tv_launch`; never `icacls` on WindowsApps |
| Windows: `Invoke-CommandInDesktopPackage` fails with `0x800704C7` | Known-broken on some builds regardless of elevation; use `scripts\launch_tv_debug.ps1` instead |
| Windows: app is running but `cdp_connected: false` | It was started without the flag (e.g. from the Start menu). Re-launch via `scripts\launch_tv_debug.ps1` — the port cannot be added to a running instance |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Check `~/.claude/.mcp.json` syntax, restart Claude Code |
| `tv` command not found | Run `npm link` from the project directory |
| Tools return stale data | TradingView may still be loading — wait a few seconds |
| Pine Editor tools fail | Open the Pine Editor panel first (`ui_open_panel pine-editor open`) |

## What to Read Next

- `CLAUDE.md` — Decision tree for which tool to use when (auto-loaded by Claude Code)
- `README.md` — Full tool reference (78 MCP tools, 30 CLI commands)
- `RESEARCH.md` — Research context and open questions
