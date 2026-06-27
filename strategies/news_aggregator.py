#!/usr/bin/env python3
"""
News aggregator — tracks headline-level events that can move futures during
thin Asian-hours liquidity: Trump statements, Iran/Middle East news, oil price
moves, Fed/rate headlines. Uses Google News RSS (no API key) + yfinance for
oil price. Pure stdlib XML parsing — no feedparser dependency required.

Usage:
    python3 news_aggregator.py [--max-per-topic 5]

Output (stdout, JSON):
    {
      "topics": {
        "trump":  [ { "title": "...", "link": "...", "published": "...", "source": "..." }, ... ],
        "iran":   [ ... ],
        "fed":    [ ... ],
        "geopolitical": [ ... ]
      },
      "oil": { "WTI": { "price": 78.2, "changePct": 1.3 }, "Brent": { ... } }
    }
"""
import sys
import json
import argparse
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

import yfinance as yf

TOPICS = {
    "trump":        "Trump statement OR Trump tweet OR Trump announcement",
    "iran":         "Iran OR Strait of Hormuz OR Middle East conflict",
    "fed":          "Federal Reserve rate decision OR FOMC",
    "geopolitical": "war OR sanctions OR military strike",
}

OIL_TICKERS = {"WTI": "CL=F", "Brent": "BZ=F"}

GOOGLE_NEWS_RSS = "https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
TIMEOUT_SEC = 8


def fetch_topic(query, max_items):
    url = GOOGLE_NEWS_RSS.format(query=urllib.parse.quote(query))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
            data = resp.read()
        root = ET.fromstring(data)
        items = []
        for item in root.findall("./channel/item")[:max_items]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub_date = (item.findtext("pubDate") or "").strip()
            source_el = item.find("source")
            source = source_el.text if source_el is not None else ""
            items.append({"title": title, "link": link, "published": pub_date, "source": source})
        return items
    except Exception as e:
        return [{"error": str(e)}]


def fetch_oil():
    out = {}
    for label, ticker in OIL_TICKERS.items():
        try:
            t = yf.Ticker(ticker)
            hist = t.history(period="5d", interval="1d")
            if hist is None or hist.empty or len(hist) < 2:
                out[label] = {"error": "no data"}
                continue
            last = float(hist["Close"].iloc[-1])
            prev = float(hist["Close"].iloc[-2])
            out[label] = {
                "price": round(last, 2),
                "changePct": round((last - prev) / prev * 100, 2),
            }
        except Exception as e:
            out[label] = {"error": str(e)}
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-per-topic", type=int, default=5)
    args = parser.parse_args()

    topics = {key: fetch_topic(query, args.max_per_topic) for key, query in TOPICS.items()}
    oil = fetch_oil()

    print(json.dumps({"topics": topics, "oil": oil}))


if __name__ == "__main__":
    main()
