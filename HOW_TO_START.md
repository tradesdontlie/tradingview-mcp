# TradingView MCP — How To Start

## Every time you want to use it

### Step 1 — Launch TradingView with CDP
Open your Terminal and run:
```bash
~/tradingview-cdp.sh
```
Wait for TradingView to fully load and show your chart. **Always use this script — never open TradingView from the Dock or Applications folder.**

### Step 2 — Verify the connection
```bash
tv status
```
You should see `"cdp_connected": true`. If not, wait 10 seconds and try again.

### Step 3 — Open Claude Code in VS Code
The MCP server connects automatically. If TradingView tools aren't responding, do:
`Cmd+Shift+P` → **Developer: Reload Window**

---

## Quick checks

| What you want | Command |
|---|---|
| Check TradingView is connected | `tv status` |
| Get current price | `tv quote` |
| Take a screenshot | `tv screenshot -r chart` |
| Switch symbol | `tv symbol AAPL` |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `tv status` shows CDP failed | Force quit TradingView (`Cmd+Q`), run `~/tradingview-cdp.sh` again |
| MCP tools not available in Claude | `Cmd+Shift+P` → Developer: Reload Window |
| TradingView window goes white | Force kill processes, delete `SingletonLock` file, and relaunch:<br>`pkill -9 -f TradingView && rm -f "$HOME/Library/Application Support/TradingView/SingletonLock" && open -a TradingView --args --remote-debugging-port=9222` |
| `tv_health_check` not found in Terminal | That's a Claude tool, not a CLI command. Use `tv status` instead |


---

## What runs automatically (no action needed)

| Time | What happens |
|---|---|
| 6:15 AM Mon–Sat | News sentiment scan (Claude Haiku) |
| 6:30 AM Mon–Sat | Dual-source scanner → Alpaca trades if confirmed |
| Every 30 min (9:30–4 PM ET) | Position monitor → Telegram alerts |
| 9:30 AM & 4:00 PM ET | Google Sheets auto-sync with screenshots |
