// Market sentiment via Reddit JSON API — ported from
// atilaahmettaner/sentiment_service.py.
// Zero deps. Built-in fetch. Keyword scoring (bullish/bearish lexicon).

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_MS = 10_000;

const BULLISH = [
  'buy', 'bull', 'moon', 'pump', 'long', 'call', 'up', 'gain',
  'strong', 'breakout', 'bullish', 'rally', 'surge', 'upside',
  'accumulate', 'undervalued', 'support', 'bottom', 'recovery',
];
const BEARISH = [
  'sell', 'bear', 'dump', 'short', 'put', 'down', 'loss', 'weak',
  'crash', 'drop', 'bearish', 'tank', 'decline', 'downside',
  'overvalued', 'resistance', 'top', 'overbought', 'bubble',
];

const SUBREDDIT_GROUPS = {
  crypto: ['CryptoCurrency', 'Bitcoin', 'ethereum', 'CryptoMarkets', 'altcoin'],
  stocks: ['stocks', 'investing', 'wallstreetbets', 'StockMarket', 'ValueInvesting'],
  all:    ['wallstreetbets', 'stocks', 'investing', 'CryptoCurrency', 'StockMarket'],
};

async function fetchRedditPosts(subreddit, query, limit = 10) {
  const url =
    `https://www.reddit.com/r/${subreddit}/search.json` +
    `?q=${encodeURIComponent(query)}&sort=new&t=week&limit=${limit}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    const data = await r.json();
    return data?.data?.children || [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function scoreText(text) {
  const t = (text || '').toLowerCase();
  let bull = 0;
  let bear = 0;
  for (const w of BULLISH) if (t.includes(w)) bull++;
  for (const w of BEARISH) if (t.includes(w)) bear++;
  const total = bull + bear;
  if (total === 0) return 0.0;
  return (bull - bear) / total;
}

function label(score) {
  if (score > 0.2) return 'Strongly Bullish';
  if (score > 0.05) return 'Bullish';
  if (score < -0.2) return 'Strongly Bearish';
  if (score < -0.05) return 'Bearish';
  return 'Neutral';
}

export async function analyzeSentiment({ symbol, category = 'all', limit = 20 } = {}) {
  const subs = SUBREDDIT_GROUPS[category] || SUBREDDIT_GROUPS.all;
  const perSub = Math.max(2, Math.floor(limit / subs.length) + 1);

  const allPosts = [];
  const scores = [];

  for (const sub of subs) {
    const raw = await fetchRedditPosts(sub, symbol, perSub);
    for (const p of raw) {
      const d = p?.data || {};
      const title = d.title || '';
      const body = d.selftext || '';
      const text = `${title} ${body}`;
      const score = scoreText(text);
      scores.push(score);
      allPosts.push({
        title: title.slice(0, 120),
        upvotes: d.score || 0,
        comments: d.num_comments || 0,
        sentiment: score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral',
        url: `https://reddit.com${d.permalink || ''}`,
        subreddit: `r/${sub}`,
      });
    }
  }

  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0.0;
  allPosts.sort((a, b) => b.upvotes - a.upvotes);

  return {
    symbol: symbol.toUpperCase(),
    sentiment_score: Number(avg.toFixed(3)),
    sentiment_label: label(avg),
    posts_analyzed: scores.length,
    bullish_count: scores.filter(s => s > 0).length,
    bearish_count: scores.filter(s => s < 0).length,
    neutral_count: scores.filter(s => s === 0).length,
    top_posts: allPosts.slice(0, 5),
    sources: subs.map(s => `r/${s}`),
    timestamp: new Date().toISOString(),
  };
}
