# 📊 TradingView MCP Repository - Visual Understanding Guide

## The Core Concept (30 seconds)

```
Your TradingView Desktop Chart
         ↓ (via CDP protocol)
    MCP Server Bridge
         ↓ (via MCP protocol)
    Claude AI Assistant
         ↓
   Smart Analysis & Actions
```

**What it does:** Lets Claude AI read and control your TradingView charts.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    USER LAYER                                │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────────────┐    ┌──────────────────────────┐   │
│  │  Claude Code        │    │  Web Browser             │   │
│  │  (Advanced Users)   │    │  (Beginners - NEW!)      │   │
│  └──────────┬──────────┘    └──────────┬───────────────┘   │
│             │ MCP Protocol             │ HTTP REST API     │
└─────────────┼─────────────────────────┼──────────────────┘
              │                         │
┌─────────────┼─────────────────────────┼──────────────────┐
│             ▼                         ▼                   │
│  ┌────────────────────────────────────────────┐          │
│  │    MCP Server (Node.js)                    │          │
│  │                                             │          │
│  │  80+ Trading Tools:                         │          │
│  │  • Auto Analysis                            │          │
│  │  • Volume Profile                           │          │
│  │  • Technical Indicators                     │          │
│  │  • Chart Control                            │          │
│  │  • Widgets & UI                             │          │
│  └────────────┬────────────────────────────────┘          │
│               │ Chrome DevTools Protocol (CDP)            │
│               ▼                                             │
│  ┌────────────────────────────────────────────┐          │
│  │  TradingView Desktop App                    │          │
│  │  (Electron - running on your computer)      │          │
│  │                                             │          │
│  │  • Live Charts                              │          │
│  │  • Price Data                               │          │
│  │  • Indicators                               │          │
│  │  • Trading Tools                            │          │
│  └─────────────────────────────────────────────┘          │
│                                                             │
│  PROJECT LAYER (We Built This)                            │
└─────────────────────────────────────────────────────────────┘
```

---

## File Structure - What Goes Where

```
tradingview-mcp/
│
├── 📁 src/ ............................ MAIN SOURCE CODE
│   │
│   ├── server.js ...................... MCP Server Entry Point
│   │                                   (Starts everything)
│   │
│   ├── connection.js .................. CDP Connection Manager
│   │                                   (Talks to TradingView)
│   │
│   ├── 📁 core/ ....................... ANALYSIS ENGINES
│   │   ├── auto-analysis.js ........... Auto-detect & analyze (NEW!)
│   │   ├── indicators.js ............. RSI, MACD, Bollinger, etc.
│   │   ├── chart.js .................. Read chart data
│   │   ├── health.js ................. Check connection status
│   │   └── ...other analysis modules
│   │
│   ├── 📁 tools/ ...................... MCP TOOL DEFINITIONS
│   │   ├── auto-analysis.js ........... Expose auto_analyze tool
│   │   ├── indicators.js ............. Expose indicator tools
│   │   ├── chart.js .................. Expose chart control tools
│   │   ├── widgets.js ................ Interactive UI components
│   │   └── ...more tool definitions
│   │
│   ├── 📁 web/ ........................ WEB INTERFACE (NEW!)
│   │   ├── server.js ................. Express web server
│   │   │                               (Serves web interface)
│   │   │
│   │   └── 📁 public/ ................ Static Files
│   │       ├── landing.html .......... Home page (SEO optimized)
│   │       └── index.html ............ Analysis dashboard
│   │
│   ├── 📁 utils/ ..................... UTILITIES (NEW!)
│   │   └── env.js .................... Config validation, caching
│   │
│   └── 📁 cli/ ....................... COMMAND-LINE TOOL
│       └── index.js .................. Terminal interface
│
├── 📁 tests/ .......................... TEST FILES
│   ├── e2e.test.js ................... End-to-end tests
│   ├── pine_analyze.test.js .......... Pine Script tests
│   └── ...other tests
│
├── 📁 scripts/ ........................ HELPER SCRIPTS
│   └── launch_tv_debug_mac.sh ........ Start TradingView with CDP
│
├── 📄 package.json ................... Node.js dependencies
├── 📄 railway.json ................... Deployment config
├── 📄 .env.example ................... Environment template (NEW!)
│
└── 📚 Documentation/
    ├── README.md ..................... Project overview
    ├── QUICKSTART.md ................. 15-min setup guide
    ├── INSTALLATION.md .............. Detailed setup steps
    ├── EDUCATION.md ................. Learning guide (NEW!)
    ├── DEPLOYMENT.md ................ Railway setup (NEW!)
    ├── COMMUNITY.md ................. Outreach strategy (NEW!)
    ├── LAUNCH.md .................... Launch checklist (NEW!)
    ├── BUILD_SUMMARY.md ............. What we built (NEW!)
    ├── CLAUDE.md .................... Tool documentation
    ├── RESEARCH.md .................. Research context
    ├── SECURITY.md .................. Security info
    └── CONTRIBUTING.md .............. How to contribute
```

---

## Data Flow: "Analyze INFY"

### Scenario 1: Via Claude Code (Advanced)

```
┌─────────────────────────────────────────────────────────┐
│ User in Claude Code types:                              │
│ "auto_analyze('INFY', 'comprehensive')"                 │
└────────────┬────────────────────────────────────────────┘
             │
             ▼ MCP Protocol
┌─────────────────────────────────────────────────────────┐
│ MCP Server receives: tools/call "auto_analyze"          │
└────────────┬────────────────────────────────────────────┘
             │
             ▼ Call src/core/auto-analysis.js
┌─────────────────────────────────────────────────────────┐
│ autoAnalyzeInput('INFY', 'comprehensive')               │
│                                                          │
│ 1. detectInputType('INFY') → 'symbol'                   │
│ 2. analyzeSymbol('INFY')                                │
│    • Get current price                                  │
│    • Calculate trend                                    │
│    • Check indicators                                   │
│    • Find support/resistance                            │
│    • Generate signal                                    │
└────────────┬────────────────────────────────────────────┘
             │
             ▼ Return analysis object
┌─────────────────────────────────────────────────────────┐
│ {                                                        │
│   success: true,                                        │
│   symbol: 'INFY',                                       │
│   trend: 'Uptrend',                                     │
│   signal: 'BUY',                                        │
│   confidence: '85%',                                    │
│   technical_levels: {                                  │
│     support: 1640,                                      │
│     resistance: 1670                                    │
│   }                                                     │
│ }                                                        │
└────────────┬────────────────────────────────────────────┘
             │
             ▼ MCP Protocol back to Claude
┌─────────────────────────────────────────────────────────┐
│ Claude displays:                                        │
│ "INFY is in Uptrend. BUY signal (85% confidence)"       │
│ Support: 1640, Resistance: 1670                         │
└─────────────────────────────────────────────────────────┘
```

### Scenario 2: Via Web Interface (Beginner - NEW!)

```
┌─────────────────────────────────────────────────────────┐
│ User goes to: https://[your-railway-url]                │
│ Sees landing page                                        │
│ Clicks: "Start Analyzing"                               │
└────────────┬────────────────────────────────────────────┘
             │
             ▼ Browser opens /analysis
┌─────────────────────────────────────────────────────────┐
│ Dashboard loads (HTML/CSS/JS)                           │
│ User types "INFY" in input box                          │
│ Clicks "Analyze" button                                 │
└────────────┬────────────────────────────────────────────┘
             │
             ▼ HTTP POST to /api/analyze
┌─────────────────────────────────────────────────────────┐
│ src/web/server.js receives request                      │
│                                                          │
│ 1. Check if result in cache (60s TTL) ✓                │
│ 2. If cached, return immediately                        │
│ 3. If not cached, call core/auto-analysis.js            │
│ 4. Cache result for next 60 seconds                     │
└────────────┬────────────────────────────────────────────┘
             │
             ▼ JSON response
┌─────────────────────────────────────────────────────────┐
│ {                                                        │
│   success: true,                                        │
│   symbol: 'INFY',                                       │
│   analysis: { ... }                                     │
│ }                                                        │
└────────────┬────────────────────────────────────────────┘
             │
             ▼ JavaScript renders results
┌─────────────────────────────────────────────────────────┐
│ Dashboard shows:                                        │
│ • Trend indicator                                       │
│ • BUY/SELL signal                                       │
│ • Support/Resistance levels                             │
│ • Volume analysis                                       │
│ • Confidence percentage                                 │
└─────────────────────────────────────────────────────────┘
```

---

## Key Components Explained

### 1. MCP Server (src/server.js)
```
What: Central server that runs everything
Why: Connects Claude to tools + Web server
Does:
  • Registers 80+ tools
  • Listens for Claude requests
  • Routes to appropriate handler
  • Formats responses
```

### 2. Core Analysis (src/core/)
```
What: Business logic that calculates analysis
Why: Reusable functions for all interfaces
Files:
  • auto-analysis.js → Analyze any input
  • indicators.js → Technical indicators
  • chart.js → Read TradingView data
  • health.js → Check connection
```

### 3. Tool Definitions (src/tools/)
```
What: Exposes core functions as Claude tools
Why: Claude can call them via MCP protocol
Example: Tool "auto_analyze"
  Calls: core/auto-analysis.js::autoAnalyzeInput()
  Returns: JSON to Claude
```

### 4. Web Server (src/web/)
```
What: Express.js server for web interface
Why: Users without Claude Code can use tool
Endpoints:
  • GET / → Landing page
  • GET /analysis → Dashboard
  • POST /api/analyze → Analysis
  • POST /api/volume-profile → Volume
  • POST /api/signals → Indicators
```

### 5. Connection Manager (src/connection.js)
```
What: Manages Chrome DevTools Protocol (CDP)
Why: Talks to TradingView Electron app
Does:
  • Connects to localhost:9222
  • Reads chart data
  • Controls chart actions
  • Monitors connection status
```

---

## The Three Ways to Use It

### Method 1: Claude Code MCP (Advanced)
```
Requirements:
  ✓ Claude Code installed
  ✓ TradingView Desktop running
  ✓ MCP configured in settings.json
  
Experience:
  • Full access to 80+ tools
  • Real-time chart control
  • Complex analysis workflows
  • Interactive widgets
  
Command:
  auto_analyze('INFY')
  chart_set_timeframe('4H')
  analysis_volume_profile(...)
```

### Method 2: Web Interface (Beginner - NEW!)
```
Requirements:
  ✓ Any web browser
  ✗ NO setup needed
  
Experience:
  • Simple point-and-click
  • Educational focus
  • Mobile-friendly
  • Works anywhere
  
URL:
  https://your-deployed-url.railway.app
```

### Method 3: CLI Tool (Developer)
```
Requirements:
  ✓ Terminal/Command prompt
  ✓ Node.js installed
  
Experience:
  • Command-line interface
  • Scriptable
  • Automation ready
  
Commands:
  tv analyze INFY
  tv launch
  tv health-check
```

---

## What We Built (NEW Features)

### 1. Web Interface
```
Before: Only Claude Code users could use it
After:  Anyone can go to website + use it

Files:
  • src/web/server.js → Express server
  • src/web/public/landing.html → SEO optimized home
  • src/web/public/index.html → Analysis dashboard
  
Result: 1000x more accessible
```

### 2. Educational Content
```
Created:
  • EDUCATION.md → Learning guide
  • DEPLOYMENT.md → How to deploy
  • COMMUNITY.md → Marketing strategy
  • LAUNCH.md → Launch checklist
  
Result: Clear path to use + share
```

### 3. Production Enhancements
```
Added:
  • .env.example → Config template
  • src/utils/env.js → Validation + caching
  • Error handling → User-friendly messages
  • Response caching → 60s TTL
  • Request logging → Dev debugging
  
Result: Professional, scalable app
```

### 4. Deployment Ready
```
Files:
  • railway.json → Deploy to Railway
  • npm run web → Start web server
  
Result: Deploy in 5 minutes, reach global users
```

---

## Understanding the Tools (Examples)

### Auto Analysis Tool
```javascript
// Input: anything user types
auto_analyze('INFY')           // Stock symbol
auto_analyze('1650.50')        // Price level
auto_analyze('Is INFY up?')    // Natural language
auto_analyze('Bullish')        // Market phrase

// Output: Analysis matched to input type
{
  symbol: 'INFY',
  trend: 'Uptrend',
  signal: 'BUY',
  confidence: '85%',
  // ... more details
}
```

### Volume Profile Tool
```javascript
// Input: Symbol + price range
analysis_volume_profile({
  symbol: 'INFY',
  price_high: 1700,
  price_low: 1600
})

// Output: Volume analysis
{
  point_of_control: 1650,      // Highest volume
  value_area_high: 1675,       // 70% volume range
  value_area_low: 1625,
  support: 1625,
  resistance: 1675
}
```

### Signals Tool
```javascript
// Input: Symbol + current price
auto_signal_all_indicators({
  symbol: 'INFY',
  price: 1650
})

// Output: All indicators combined
{
  final_signal: 'BUY',         // Combined vote
  confidence: '82%',
  bullish_votes: 5,            // 5 indicators bullish
  bearish_votes: 1,            // 1 indicator bearish
  all_indicators: {
    rsi: 'Bullish',
    macd: 'Bullish',
    volume: 'Bullish',
    // ...
  }
}
```

---

## Why This Matters

### Problem (Before)
- Beginners couldn't learn trading safely
- Paid courses cost $500+
- No free paper trading education
- Technical analysis seemed complex

### Solution (After)
- Free web interface (anyone can use)
- Educational guides included
- Paper trading (no real money risk)
- Instant stock analysis
- Community-driven

### Impact
- Reaches underserved communities (India, emerging markets)
- Removes financial barriers
- Makes trading education democratic
- Safe learning environment

---

## Quick Reference: What Each Layer Does

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **User** | Claude Code / Web Browser | Interface |
| **Protocol** | MCP / HTTP | Communication |
| **Server** | Node.js Express | Processing |
| **Analysis** | JavaScript | Calculation |
| **Connection** | Chrome DevTools Protocol | TradingView access |
| **Storage** | In-memory cache | Performance |
| **Deployment** | Railway | Hosting |

---

## How to Start

### To Understand More
1. Read `README.md` → Overview
2. Read `QUICKSTART.md` → 15-min guide
3. Explore `src/core/auto-analysis.js` → Main logic
4. Look at `src/web/server.js` → Web interface

### To Use It
1. **Claude Code users**: Install locally + connect
2. **Everyone else**: Wait for deployment URL
3. **Developers**: Fork + deploy to Railway

### To Contribute
1. Fix typos in docs
2. Add new indicators
3. Improve UI/UX
4. Write tutorials

---

## The Complete Picture

```
GOALS
├── Educate traders safely ✓
├── Reach underserved communities ✓
├── Make it free ✓
├── Make it accessible (no setup) ✓
└── Build community ✓

FEATURES
├── 80+ trading tools ✓
├── Web interface ✓
├── Educational content ✓
├── Paper trading ✓
├── Auto analysis ✓
└── Multi-platform access ✓

DEPLOYMENT
├── Local (Claude Code) ✓
├── Web (Railway) ✓
├── CLI (Terminal) ✓
└── Community (Open source) ✓
```

---

**You now understand the entire TradingView MCP repository. 🎉**

Questions? Check the specific file documentation or ask in discussions.
