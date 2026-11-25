# MT5 Tree Bot

A demo-first trading infrastructure project combining a Python risk-managed engine, a browser console, and an Expo mobile companion app.

> [!CAUTION]
> No strategy has passed production validation. Use simulation or an MT5 demo account only. Do not use real money or treat the included placeholders and research tools as investment advice.

## Repository layout

| Area | Purpose |
|---|---|
| `trading-bot/` | Python engine, simulator, MT5 demo adapter, web console, research tools, and tests |
| `mobile/` | Expo/React Native companion application |
| `src/` | TradingView MCP bridge retained from the original repository |

## Trading bot quick start

```bash
cd trading-bot
python -m venv venv
# macOS/Linux
source venv/bin/activate
# Windows
# venv\Scripts\activate
pip install -r requirements.txt
python app.py --mode sim
```

Open `http://127.0.0.1:8765` unless another host or port is configured.

## Demo safety

- Prefer `python app.py --mode sim` for development.
- The demo broker mode requires an MT5 demo account.
- `run_demo.py` uses placeholder random signals and is only a plumbing test.
- Live-account and real-money validation are out of scope until independent strategy and broker validation are complete.

## Tests

```bash
cd trading-bot
python -m unittest discover -s tests -v
```

The GitHub Actions workflow runs this suite for changes under `trading-bot/`.

## Mobile app

```bash
cd mobile
npm install
npx expo start
```

Set the documented Expo public Supabase variables before starting the app. Secure connection storage is intended for Android and is unavailable on web builds.

## Documentation

- `trading-bot/README.md` — engine and console details
- `SETUP_GUIDE.md` — original TradingView MCP setup
- `SECURITY.md` — security policy
- `CONTRIBUTING.md` — contribution guidance
