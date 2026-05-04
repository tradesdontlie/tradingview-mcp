/**
 * Benchmark routes.
 *
 * GET  /api/benchmarks          → list recent runs (summary)
 * GET  /api/benchmarks/:id      → full BenchmarkResult
 * POST /api/benchmarks/run      → { trades, bars, equity, options } → run scoring + store
 */

import { Router } from 'express';
import { runBenchmark } from '../../../scoring/index.js';
import { saveResult, loadResult, listResults } from '../../../scoring/store.js';

export const router = Router();

router.get('/', (req, res) => {
  try {
    const { symbol, algo_hash: algoHash, limit = 50 } = req.query;
    const rows = listResults({ symbol, algoHash, limit: Math.min(Number(limit), 200) });
    res.json({ success: true, results: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const result = loadResult(req.params.id);
    if (!result) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/run', (req, res) => {
  try {
    const { trades, bars, equity, options = {} } = req.body;

    if (!Array.isArray(trades) || !trades.length) {
      return res.status(400).json({ success: false, error: 'trades[] required' });
    }
    if (!Array.isArray(equity) || !equity.length) {
      return res.status(400).json({ success: false, error: 'equity[] required' });
    }

    const result = runBenchmark(trades, bars ?? [], equity, options);
    const id = saveResult(result);
    res.json({ success: true, id, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
