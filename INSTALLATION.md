# TradingView MCP - Installation & Setup Guide

Professional installation guide for Claude Code MCP integration with TradingView Desktop.

## 📋 Prerequisites

- **TradingView Desktop** (Windows/Mac/Linux)
- **Node.js** v18+ (download from [nodejs.org](https://nodejs.org))
- **Claude Code** (free tier available)
- **GitHub Account** (for MCP source)

---

## 🚀 Quick Start (5 minutes)

### 1. Clone Repository

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git
cd tradingview-mcp
npm install
```

### 2. Start MCP Server

```bash
npm start
```

Expected output:
```
⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.
   Ensure your usage complies with TradingView's Terms of Use.
```

### 3. Connect to Claude Code

**Claude Code Settings** → **MCP Servers** → **Add New**

```
Name: tradingview-mcp
Command: npm start
Directory: /path/to/tradingview-mcp
```

Click **Connect**

### 4. Start Trading

Open Claude Code chat, test:

```
widget_picker_form({ current_symbol: 'SPY', symbols: ['SPY', 'QQQ', 'INFY'] })
```

Should render interactive picker form in chat ✓

---

## 🔧 System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| Node.js | v18 | v24+ |
| RAM | 2GB | 8GB+ |
| Disk | 500MB | 2GB |
| TradingView | Desktop app | Latest version |
| Internet | Required | 10+ Mbps |

---

## 📦 Installation Methods

### Method 1: npm (Recommended)

```bash
npm install -g tradingview-mcp
tradingview-mcp
```

### Method 2: Docker

```bash
docker run -it -p 9222:9222 tradingview-mcp:latest
```

### Method 3: Source Installation

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git
cd tradingview-mcp
npm install
npm start
```

---

## 🔌 MCP Server Configuration

### Claude Code Settings (Mac/Linux)

**File:** `~/.claude/settings.json`

```json
{
  "mcpServers": {
    "tradingview-mcp": {
      "command": "npm",
      "args": ["start"],
      "cwd": "/path/to/tradingview-mcp",
      "env": {
        "CDP_HOST": "localhost",
        "CDP_PORT": "9222"
      }
    }
  }
}
```

### Chrome DevTools Protocol (CDP) Setup

1. **Start TradingView Desktop with CDP enabled:**
   ```bash
   # Windows
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

   # Mac
   open -a "Google Chrome" --args --remote-debugging-port=9222

   # Linux
   google-chrome --remote-debugging-port=9222
   ```

2. **Verify CDP is working:**
   ```bash
   curl http://localhost:9222/json
   ```

   Should return JSON with tab/process info ✓

---

## 🎯 First-Time Setup Checklist

- [ ] Node.js installed (`node --version` shows v18+)
- [ ] TradingView Desktop running
- [ ] CDP port 9222 accessible (`curl http://localhost:9222/json` works)
- [ ] MCP server started (`npm start` shows no errors)
- [ ] Claude Code MCP server connected
- [ ] Test widget renders in chat

---

## 🧪 Testing Installation

### Test 1: Widget Rendering

```javascript
widget_picker_form({
  current_symbol: 'SPY',
  current_timeframe: '1H',
  symbols: ['SPY', 'QQQ', 'INFY', 'TCS']
})
```

**Expected:** Interactive form appears in Claude Code chat ✓

### Test 2: Chart Analysis

```javascript
chart_complete_analysis({
  symbol: 'INFY',
  timeframe: '1H',
  price: 1650.00,
  volume: 1500000
})
```

**Expected:** Complete analysis with all indicators ✓

### Test 3: Agent System

```javascript
agent_orchestrate({
  symbol: 'TCS',
  timeframe: '4H',
  account_size: 50000,
  auto_execute: false
})
```

**Expected:** Research → Analyst → Decision flow completes ✓

---

## 📊 Tools Available (70+)

### Interactive Widgets (6)
- `widget_picker_form` - Symbol/timeframe selector
- `widget_strategy_params` - Parameter input form
- `widget_dashboard` - Real-time dashboard
- `widget_confirmation` - Trade confirmation
- `widget_table` - Sortable data table
- `widget_alert` - Alert banners

### Backtest Engine (8)
- `backtest_run` - Execute strategy tester
- `backtest_metrics` - Performance metrics
- `backtest_equity_curve` - Equity visualization
- `backtest_trades` - Trade history
- Plus optimization & export tools

### Trade Analytics (12)
- `analytics_win_loss` - Win/loss analysis
- `analytics_drawdown` - Max drawdown calculation
- `analytics_duration` - Trade duration stats
- `analytics_risk_reward` - R:R ratio analysis
- Plus 8 more analysis tools

### Agent System (6)
- `agent_research` - Market data research
- `agent_analyst` - Signal generation
- `agent_decision` - Trade decision making
- `agent_orchestrate` - Full workflow
- Plus 2 widgets for visualization

### India Institutions (11)
- `india_market_context` - Nifty/Sensex data
- `india_fii_dii_analysis` - FII/DII flows
- `india_block_deals` - Institutional tracking
- Plus 8 more India-specific tools

### Chart Analysis (8)
- `chart_complete_analysis` - All indicators
- `analysis_fixed_range` - RSI, Stochastic, CCI
- `analysis_volume` - Volume analysis
- `analysis_fibonacci` - Fibonacci levels
- Plus 4 more analysis tools

### User Decision Framework (7)
- `user_pretrade_checklist` - Pre-trade checklist
- `reality_check_backtest_vs_live` - Expectations
- `recommend_paper_trading` - Trading plan
- `assess_user_readiness` - Readiness assessment
- Plus 3 more decision tools

### Compliance & Education (6)
- `widget_compliance_disclaimer` - SEBI notices
- `analysis_educational` - Educational analysis
- `widget_risk_disclosure` - Risk warnings
- Plus 3 more compliance tools

---

## 🐛 Troubleshooting

### Issue: "Cannot find module 'connection'"
**Solution:** Ensure all dependencies installed
```bash
npm install
npm start
```

### Issue: CDP port 9222 not accessible
**Solution:** Start TradingView with CDP enabled
```bash
# Restart TradingView with remote debugging
google-chrome --remote-debugging-port=9222
```

### Issue: MCP server not connecting to Claude Code
**Solution:** Check settings.json path and restart Claude Code
```bash
# Verify path
ls ~/.claude/settings.json

# Restart Claude Code
```

### Issue: Widgets not rendering in chat
**Solution:** Ensure MCP server running and connected
```bash
# Check server status
curl http://localhost:9222/json

# Restart if needed
npm start
```

---

## 📚 Documentation

- **[README.md](README.md)** - Project overview
- **[CLAUDE.md](CLAUDE.md)** - Claude instructions
- **[WIDGETS.md](WIDGETS.md)** - Widget reference
- **[BACKTEST_WORKFLOW.md](BACKTEST_WORKFLOW.md)** - Backtest guide
- **[RESEARCH.md](RESEARCH.md)** - Research notes

---

## ⚖️ Legal & Disclaimers

**NOT SEBI Registered**
- This tool is for **educational purposes only**
- NOT investment advice
- NO buy/sell recommendations
- Always consult SEBI-registered advisors

**Terms of Use**
- Unofficial TradingView tool
- Ensure compliance with TradingView ToS
- User bears all trading risks
- Authors not liable for losses

---

## 🤝 Support & Contributions

- **Issues:** [GitHub Issues](https://github.com/tradesdontlie/tradingview-mcp/issues)
- **Discussions:** [GitHub Discussions](https://github.com/tradesdontlie/tradingview-mcp/discussions)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 📈 Getting Help

1. Check [Troubleshooting](#-troubleshooting) section
2. Search [GitHub Issues](https://github.com/tradesdontlie/tradingview-mcp/issues)
3. Ask in [Discussions](https://github.com/tradesdontlie/tradingview-mcp/discussions)
4. Review [CLAUDE.md](CLAUDE.md) for detailed tool docs

---

## ✅ What's Next?

After successful installation:

1. **Learn the basics** → Read [WIDGETS.md](WIDGETS.md)
2. **Try backtest workflow** → Read [BACKTEST_WORKFLOW.md](BACKTEST_WORKFLOW.md)
3. **Understand agent system** → Test `agent_orchestrate` tool
4. **Paper trade first** → Use `user_pretrade_checklist`
5. **Start with education** → Use `analysis_educational` tools

---

**Last Updated:** August 9, 2026  
**Version:** 1.0.0  
**Status:** Production Ready ✓
