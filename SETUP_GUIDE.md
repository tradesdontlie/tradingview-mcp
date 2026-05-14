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

## Selecting a Specific Chart (Multiple Charts Open)

TradingView Desktop frequently has several chart pages open simultaneously. By default the MCP connects to the first chart page it finds via CDP, which may not be the one you want. To pin the MCP to a specific chart, set one of these environment variables in the `env` object of your `~/.claude/.mcp.json` entry **before** Claude Code launches the server:

| Env var | Type | Match | Example |
|---------|------|-------|---------|
| `TRADINGVIEW_TARGET_ID` | string | Prefix-match against the CDP target id | `"3E096BC2"` (first 8 chars are enough) |
| `TRADINGVIEW_CHART_URL` | string | Substring match against the chart URL | `"R2Nyob9Y"` (the chart's slug from `tradingview.com/chart/<slug>/`) |

Precedence: `TRADINGVIEW_TARGET_ID` > `TRADINGVIEW_CHART_URL` > default (first chart page).

**To list the available targets:**
```bash
curl -s http://127.0.0.1:9222/json/list | grep -oE '"id":[^,]+|"url":[^,]+' | head -20
```

**Example MCP config with a pinned chart:**
```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["<INSTALL_PATH>/src/server.js"],
      "env": {
        "TRADINGVIEW_CHART_URL": "R2Nyob9Y"
      }
    }
  }
}
```

Note: these env vars are read at MCP-server startup. Switching the active chart requires restarting Claude Code (which respawns the MCP server).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | Launch TradingView with `--remote-debugging-port=9222` |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Check `~/.claude/.mcp.json` syntax, restart Claude Code |
| `tv` command not found | Run `npm link` from the project directory |
| Tools return stale data | TradingView may still be loading — wait a few seconds |
| Pine Editor tools fail | Open the Pine Editor panel first (`ui_open_panel pine-editor open`) |
| MCP connects to wrong chart | Set `TRADINGVIEW_CHART_URL` or `TRADINGVIEW_TARGET_ID` env var (see "Selecting a Specific Chart" above) |

## What to Read Next

- `CLAUDE.md` — Decision tree for which tool to use when (auto-loaded by Claude Code)
- `README.md` — Full tool reference (78 MCP tools, 30 CLI commands)
- `RESEARCH.md` — Research context and open questions
