-- Benchmark results store.
-- Keyed by (algo_hash, symbol, timeframe, date_start, date_end, cost_model_hash).

CREATE TABLE IF NOT EXISTS benchmarks (
  id              TEXT PRIMARY KEY,          -- UUID v4
  algo_hash       TEXT NOT NULL,             -- SHA-256 of Pine source
  symbol          TEXT NOT NULL,
  timeframe       TEXT NOT NULL,
  date_start      TEXT NOT NULL,             -- ISO date
  date_end        TEXT NOT NULL,             -- ISO date
  cost_model      TEXT NOT NULL,             -- JSON { fee_pct, slippage_pct, fill_model }
  cost_model_hash TEXT NOT NULL,             -- SHA-256 of cost_model JSON

  -- Composite
  composite_score REAL NOT NULL,
  weights         TEXT NOT NULL,             -- JSON { returns, robustness, cost, regimes }

  -- Dimension scores (0–100)
  score_returns    REAL NOT NULL,
  score_robustness REAL NOT NULL,
  score_cost       REAL NOT NULL,
  score_regimes    REAL NOT NULL,

  -- Full result payload
  result_json     TEXT NOT NULL,             -- serialized BenchmarkResult

  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_benchmarks_algo ON benchmarks(algo_hash);
CREATE INDEX IF NOT EXISTS idx_benchmarks_symbol ON benchmarks(symbol, timeframe);
CREATE INDEX IF NOT EXISTS idx_benchmarks_created ON benchmarks(created_at DESC);

-- Optional: tag runs for easy filtering in the UI
CREATE TABLE IF NOT EXISTS benchmark_tags (
  benchmark_id TEXT NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
  tag          TEXT NOT NULL,
  PRIMARY KEY (benchmark_id, tag)
);
