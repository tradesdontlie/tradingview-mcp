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

Register the server with the Claude Code MCP CLI (preferred — it edits the right file with the right structure):

```bash
claude mcp add tradingview --scope user -- node <INSTALL_PATH>/src/server.js
```

`--scope user` writes a top-level `mcpServers` entry into `~/.claude.json` so the server is available in every project. Use `--scope project` instead to write a `.mcp.json` at the project root (committed, shared).

If editing config by hand, the file is `~/.claude.json` (user scope) or `<project>/.mcp.json` (project scope). **Do not use `~/.claude/.mcp.json` — Claude Code does not read that path.** The entry to add (under top-level `mcpServers` for user scope, or top-level for project scope):

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

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | Launch TradingView with `--remote-debugging-port=9222` |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Confirm entry is in `~/.claude.json` (user scope) or `<project>/.mcp.json` (project scope) — not `~/.claude/.mcp.json`. Validate JSON, then restart Claude Code |
| `tv` command not found | Run `npm link` from the project directory |
| Tools return stale data | TradingView may still be loading — wait a few seconds |
| Pine Editor tools fail | Open the Pine Editor panel first (`ui_open_panel pine-editor open`) |

## What to Read Next

- `CLAUDE.md` — Decision tree for which tool to use when (auto-loaded by Claude Code)
- `README.md` — Full tool reference (78 MCP tools, 30 CLI commands)
- `RESEARCH.md` — Research context and open questions
