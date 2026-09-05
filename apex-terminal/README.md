# APEX Terminal

A live cross-asset, credit-stress, macro and volatility dashboard, driven by a manual
push routine over keyless public data. No API key, anywhere.

```bash
python3 bake.py     # fetch live data, compute, validate, write public/api/, render the snapshot
python3 serve.py    # http://127.0.0.1:8787
```

The frontend is Perplexity's compiled APEX build. It ships **without the backend it
expects** and with a broken API base URL, so this repo supplies both:
`lib/patch_frontend.py` repairs the bundle, and `bake.py` produces the twelve `/api/*`
payloads it fetches.

**Every panel is live.** Cross-asset scorecard (12 assets, 1D/1W/1M/3M momentum,
50/200-day trend flags), credit stress, a nine-tell volatility and stress radar built on
the CBOE vol complex and ICE BofA high-yield spreads, a regime gauge, macro for four
economies, market pulse, threshold alerts, a ten-year 200-day trend backtest with cost
and fill-delay sensitivity, and smart money — 13F holdings, analyst consensus and
congressional trades read from the House Clerk's own filings.

Sources: Nasdaq, CBOE, FRED, OECD, Eurostat, CoinGecko and the House Clerk, with Yahoo
as a deliberate last resort. Two things stay honestly blank — `^MOVE` (no free feed;
CBOE's VXTLT covers the tell) and Japan inflation (dead at the source).

Each bake also renders `report/apex-readout.html`, a self-contained snapshot published as
a Claude Artifact.

See [RUNBOOK.md](RUNBOOK.md) for sources, flags, failure modes and the reasons behind
each choice.

> Decision-support analytics only. Not investment advice. Regime scores, trend labels and
> radar tiers are derived heuristics, not market facts.
