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

TradingView for Windows now ships **only as an MSIX package** (Microsoft Store and tvd-packages.tradingview.com both install under `C:\Program Files\WindowsApps\`). Use the launch script — it resolves the install via `Get-AppxPackage`, which works without admin rights:

```bat
scripts\launch_tv_debug.bat
```

Or, preferred: let the `tv_launch` MCP tool do it — it auto-detects MSIX installs and, on Windows builds where launching from `WindowsApps` is blocked with **"Access is denied"**, automatically copies the package to `%LOCALAPPDATA%\tradingview-mcp\` (one-time, ~330MB) and launches from the copy. The copy keeps your login, layout, and chart state. If the fallback was used, the result includes `msix_local_copy: true`.

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

## Step 7: MT5 Trading (Optional)

Only do this if the user explicitly asks for MT5/MetaTrader trading support — it is a separate, opt-in module that executes real orders (demo or live, depending on which account the user logs into). Do not set it up proactively.

1. Confirm the MT5 terminal runs on **Windows** (the `MetaTrader5` Python package requires it) and that Python 3.9+ is available there.
2. Install the package: `pip install MetaTrader5`
3. Start the bridge on that same machine, with the MT5 terminal already open (or let the bridge launch it via `MT5_TERMINAL_PATH`):
   ```bash
   python scripts/mt5_bridge.py
   ```
   For auto-login, set `MT5_LOGIN`, `MT5_PASSWORD`, `MT5_SERVER` env vars first.
4. The bridge prints which account it connected to and whether it's demo or live — read that output back to the user so they can confirm it's the account they intended.
5. Verify from Claude Code with the `mt5_health_check` tool, then `mt5_get_account` to confirm `is_demo`.
6. Before ever calling `mt5_place_order` or `mt5_close_order`, tell the user which account (`is_demo`) the order will hit and get explicit confirmation — those tools also require `confirm: true` in the call itself.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | Launch TradingView with `--remote-debugging-port=9222` |
| Windows: "Access is denied" launching from `WindowsApps` | Use `tv_launch` (auto copy-fallback) or the manual copy snippet in Step 3 — never `icacls` on WindowsApps |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Check `~/.claude/.mcp.json` syntax, restart Claude Code |
| `tv` command not found | Run `npm link` from the project directory |
| Tools return stale data | TradingView may still be loading — wait a few seconds |
| Pine Editor tools fail | Open the Pine Editor panel first (`ui_open_panel pine-editor open`) |
| MT5 bridge unreachable | Confirm `python scripts/mt5_bridge.py` is running on the machine with the MT5 terminal, and that `MT5_BRIDGE_HOST`/`MT5_BRIDGE_PORT` match on both sides (default `127.0.0.1:8721`) |
| `mt5_place_order`/`mt5_close_order` reject the call | These require `confirm: true` in the tool call — this is intentional, not a bug |

## What to Read Next

- `CLAUDE.md` — Decision tree for which tool to use when (auto-loaded by Claude Code)
- `README.md` — Full tool reference (78 MCP tools, 30 CLI commands)
- `RESEARCH.md` — Research context and open questions
