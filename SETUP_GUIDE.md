# Setup Guide for Claude Code

This file is a step-by-step guide for Claude Code (or any LLM agent) to install and configure the TradingView MCP server. If a user asks you to install or set up this project, follow these steps exactly.

## Step 1: Clone and Install

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git ~/tradingview-mcp
cd ~/tradingview-mcp
npm install
```

If the user specifies a different install path, use that instead of `~/tradingview-mcp`.

## Step 2: Register the MCP Server

Register the server with Claude Code using the `claude mcp add` CLI. This writes to the config file Claude Code actually reads, so it is the reliable path.

**User scope** (loads in every project — recommended):

```bash
claude mcp add tradingview -s user -- node <INSTALL_PATH>/src/server.js
```

**Project scope** (this project only, shareable via git):

```bash
claude mcp add tradingview -s project -- node <INSTALL_PATH>/src/server.js
```

Replace `<INSTALL_PATH>` with the absolute path where the repo was cloned. On Windows, pass the full native path, e.g. `C:\Users\username\tradingview-mcp\src\server.js`.

Verify it registered:

```bash
claude mcp list
```

Expected output:

```
tradingview: node <INSTALL_PATH>/src/server.js - ✔ Connected
```

### Editing config by hand

If you would rather edit JSON directly, the files Claude Code reads are `~/.claude.json` (user scope) or `.mcp.json` in the project root (project scope). The entry goes under an `mcpServers` object:

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

If the file already exists and has other servers, merge the `tradingview` entry into the existing `mcpServers` object. Do not overwrite other servers.

> **Note:** `~/.claude/.mcp.json` is **not** read by Claude Code. Earlier versions of this guide pointed there; a config at that path is silently ignored and `claude mcp list` will report no servers. If you have one, re-register with `claude mcp add` above.

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

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | Launch TradingView with `--remote-debugging-port=9222` |
| Windows: "Access is denied" launching from `WindowsApps` | Use `tv_launch` (auto copy-fallback) or the manual copy snippet in Step 3 — never `icacls` on WindowsApps |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Run `claude mcp list` — if empty, the server was never registered (see Step 2). `~/.claude/.mcp.json` is not read by Claude Code. Restart Claude Code after registering. |
| `tv` command not found | Run `npm link` from the project directory |
| Tools return stale data | TradingView may still be loading — wait a few seconds |
| Pine Editor tools fail | Open the Pine Editor panel first (`ui_open_panel pine-editor open`) |

## What to Read Next

- `CLAUDE.md` — Decision tree for which tool to use when (auto-loaded by Claude Code)
- `README.md` — Full tool reference (84 MCP tools, 30 CLI commands)
- `RESEARCH.md` — Research context and open questions
