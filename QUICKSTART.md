# 🚀 TradingView MCP - Complete Installation Guide

**Easy Step-by-Step Setup (15 minutes)**

---

## ✅ What You'll Get

- **80+ Trading Analysis Tools**
- **20+ Interactive Widgets** 
- **Automated Analysis** (type anything, get analysis)
- **Volume Profile, POC, Value Area** analysis
- **3-Agent System** (Research → Analyst → Decision)
- **Paper Trading Validation**
- **Real-time Charts** via TradingView Desktop
- **Educational Framework** (NOT investment advice)

---

## 📋 Pre-Installation Checklist

Before you start, make sure you have:

- [ ] **Windows/Mac/Linux** computer
- [ ] **TradingView Desktop** app (free download)
- [ ] **Node.js v18+** (we'll download this)
- [ ] **Claude Code** (free tier works)
- [ ] **Internet connection**
- [ ] **15 minutes** of free time

---

## 🎯 Step 1: Download & Install Node.js

Node.js is the engine that runs the MCP server.

### Mac Users:
1. Go to https://nodejs.org
2. Click **"LTS" (Long Term Support)**
3. Click **download**
4. Run the installer
5. Follow on-screen prompts (click Next/Continue)

### Windows Users:
1. Go to https://nodejs.org
2. Click **"LTS" (Long Term Support)**
3. Click **Windows Installer**
4. Run `.msi` file
5. Follow installer steps (default settings OK)

### Linux Users:
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install nodejs npm

# macOS (using Homebrew)
brew install node
```

**Verify Installation:**
Open terminal/command prompt and type:
```bash
node --version
```

Should show: `v18.xx.x` or higher ✓

---

## 📥 Step 2: Download TradingView MCP Code

### Option A: Download ZIP (Easiest)

1. Go to: https://github.com/tradesdontlie/tradingview-mcp
2. Click **Code** (green button)
3. Click **Download ZIP**
4. Extract/unzip the folder
5. Remember where you saved it

### Option B: Using Git (Advanced)

```bash
git clone https://github.com/tradesdontlie/tradingview-mcp.git
cd tradingview-mcp
```

---

## 🔧 Step 3: Install Dependencies

Open terminal/command prompt in the extracted folder:

```bash
# Windows: Use Command Prompt
# Mac/Linux: Use Terminal

cd tradingview-mcp
npm install
```

**What this does:** Downloads all required tools (takes 2-3 minutes)

**Expected output:** Should end with `added XXX packages` ✓

---

## 🚀 Step 4: Start TradingView Desktop

1. Open **TradingView Desktop** app
2. Log in with your account
3. Open any chart (e.g., SPY/NIFTY/INFY)
4. **Leave it running** (MCP needs it open)

---

## ⚙️ Step 5: Start MCP Server

In terminal/command prompt (in tradingview-mcp folder):

```bash
npm start
```

**Expected output:**
```
⚠  tradingview-mcp  |  Unofficial tool...
   Ensure your usage complies with TradingView's Terms of Use.
```

**Leave this window OPEN** ✓

---

## 🔌 Step 6: Connect to Claude Code

### On Mac/Linux:

1. Open file: `~/.claude/settings.json`
   - If doesn't exist, create it
   - Or use: `nano ~/.claude/settings.json`

2. Add this code:
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

**Replace:** `/path/to/tradingview-mcp` with your actual path
(e.g., `/Users/yourname/Downloads/tradingview-mcp`)

3. Save file

### On Windows:

1. Open file: `%USERPROFILE%\.claude\settings.json`
2. Add same code as above (replace paths with Windows format)
3. Save file

### In Claude Code App:

1. Open **Claude Code**
2. Go to **Settings** → **MCP Servers**
3. Click **Add New**
4. Enter:
   - **Name:** `tradingview-mcp`
   - **Command:** `npm start`
   - **Directory:** (path to your folder)
5. Click **Connect**

Should show: **Connected ✓**

---

## ✅ Step 7: Test It Works

Open Claude Code chat and type:

```
widget_picker_form({ current_symbol: 'SPY', symbols: ['SPY', 'QQQ', 'INFY'] })
```

**You should see:** Interactive dropdown form in chat ✓

---

## 🎮 Step 8: Start Using

Try these commands:

### Test 1: Analyze a Stock
```
auto_analyze('INFY', 'comprehensive')
```

### Test 2: Check Trend
```
natural_analysis('What is the trend in SPY?')
```

### Test 3: Volume Profile
```
analysis_volume_profile({ symbol: 'TCS', price_high: 4150, price_low: 4050 })
```

### Test 4: See All Indicators
```
auto_signal_all_indicators('RELIANCE', 2985.50)
```

### Test 5: User Decision
```
user_pretrade_checklist({ user_experience: 'beginner', capital_available: 50000, monthly_income: 5000 })
```

---

## 🐛 Troubleshooting

### ❌ "Cannot find module"
**Solution:**
```bash
npm install
npm start
```

### ❌ "Port 9222 not accessible"
**Solution:** 
Make sure TradingView Desktop is running and fully loaded.

### ❌ "MCP not connecting"
**Solution:**
1. Restart Claude Code
2. Check settings.json path is correct
3. Restart MCP server

### ❌ "Widgets not showing"
**Solution:**
- Ensure MCP server is running (terminal shows no errors)
- Try simpler command first: `widget_alert({ type: 'info', title: 'Test', message: 'Test' })`

---

## 📚 What Each Tool Does

### Automatic Analysis (Type Anything)
- `auto_analyze` - Analyzes ANY input automatically
- `natural_analysis` - Understands plain English questions

### Volume Analysis
- `analysis_volume_profile` - Fixed range volume levels
- `analysis_poc` - Point of Control (highest volume)
- `analysis_value_area` - 70% volume concentration
- `analysis_volume_imbalance` - Buy/sell pressure

### Complete Analysis
- `chart_complete_analysis` - All indicators at once
- `auto_signal_all_indicators` - Signal confirmation

### 3-Agent System
- `agent_research` - Gathers market data
- `agent_analyst` - Generates trading signals
- `agent_decision` - Makes final decision
- `agent_orchestrate` - Runs full workflow

### India Market
- `india_market_context` - Nifty/Sensex data
- `india_fii_dii_analysis` - FII/DII flows
- `india_institutional_signal` - Institutional activity

### User Decision
- `user_pretrade_checklist` - Before you trade
- `reality_check_backtest_vs_live` - Why backtests ≠ profits
- `assess_user_readiness` - Are you ready?

### Widgets (Display Results)
- `widget_picker_form` - Choose stock/timeframe
- `widget_dashboard` - Live metrics
- `widget_table` - Data display
- `widget_confirmation` - Confirm trade
- Many more...

---

## 🎓 Learning Path

**Day 1: Setup & Explore**
- Install (Steps 1-7)
- Test simple commands
- Explore widgets

**Day 2-3: Learn Analysis**
- Try `auto_analyze` with different symbols
- Read `WIDGETS.md` guide
- Test each widget

**Day 4-7: Paper Trade**
- Run `user_pretrade_checklist`
- Use `chart_complete_analysis`
- Paper trade 7 days

**Week 2+: Validate Strategy**
- Run backtests
- Paper trade results
- Only then consider real money (small)

---

## ⚠️ Important Reminders

### ✅ This Tool IS For:
- Learning market analysis
- Educational exploration
- Paper trading (simulated)
- Understanding trading concepts
- Backtesting strategies
- Risk management education

### ❌ This Tool is NOT For:
- Investment advice
- Buy/sell recommendations (we can't do this legally)
- Guaranteed profits
- Day trading without experience
- Large capital risking

### 🛑 Before Real Trading:
1. Complete pre-trade checklist
2. Paper trade for 3-6 months
3. Understand risks fully
4. Have 6+ months emergency fund
5. Only risk 1-2% per trade
6. Consult SEBI-registered advisor

---

## 📞 Need Help?

**Common Issues:**
- Check [Troubleshooting](#-troubleshooting) section above
- Read `INSTALLATION.md` in the repo
- Check `WIDGETS.md` for widget examples

**GitHub:**
- Issues: https://github.com/tradesdontlie/tradingview-mcp/issues
- Discussions: https://github.com/tradesdontlie/tradingview-mcp/discussions

---

## 🎉 Success Indicators

You'll know it's working when:

- ✓ MCP server starts without errors
- ✓ Claude Code shows "Connected"
- ✓ Widgets display in chat
- ✓ `auto_analyze` returns results
- ✓ Charts load in TradingView
- ✓ All 80+ tools available

---

## 🚀 Next Steps

1. **Download Node.js** from nodejs.org
2. **Download MCP code** from GitHub
3. **Run `npm install`** 
4. **Start server:** `npm start`
5. **Connect Claude Code**
6. **Test first widget**
7. **Start analyzing!**

---

## 📋 Quick Reference

```bash
# Download Node.js
Visit: https://nodejs.org

# Download MCP
git clone https://github.com/tradesdontlie/tradingview-mcp.git

# Install dependencies
npm install

# Start server
npm start

# Test in Claude Code
auto_analyze('INFY', 'comprehensive')
```

---

**Installation Time:** 15 minutes
**Complexity:** Easy (no coding needed)
**Support:** GitHub Issues/Discussions

**Ready? Start with Step 1 above! 👆**

---

**Last Updated:** August 9, 2026
**Version:** 1.0.0 - Production Ready
