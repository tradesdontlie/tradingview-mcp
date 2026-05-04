/**
 * SQLite persistence for BenchmarkResult objects.
 * Uses better-sqlite3 (synchronous API).
 *
 * Key: (algo_hash, symbol, timeframe, date_start, date_end, cost_model_hash)
 * Identical runs return the cached result.
 */

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dir, 'schema.sql');
const DEFAULT_DB_PATH = join(__dir, '..', 'data', 'bench.db');

let _db = null;

export function getDb(dbPath = DEFAULT_DB_PATH) {
  if (_db) return _db;
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  _db.exec(schema);
  return _db;
}

export function closeDb() {
  if (_db) { _db.close(); _db = null; }
}

/**
 * Save a BenchmarkResult to the store.
 * If an identical run exists, returns the existing id without overwriting.
 *
 * @param {BenchmarkResult} result
 * @param {string} [dbPath]
 * @returns {string} id
 */
export function saveResult(result, dbPath) {
  const db = getDb(dbPath);

  const costHash = hashJson(result.costModel);
  const existing = db.prepare(`
    SELECT id FROM benchmarks
    WHERE algo_hash = ? AND symbol = ? AND timeframe = ?
      AND date_start = ? AND date_end = ? AND cost_model_hash = ?
    LIMIT 1
  `).get(result.algoHash, result.symbol, result.timeframe,
         result.dateRange.start, result.dateRange.end, costHash);

  if (existing) return existing.id;

  const id = randomUUID();
  const stmt = db.prepare(`
    INSERT INTO benchmarks
      (id, algo_hash, symbol, timeframe, date_start, date_end,
       cost_model, cost_model_hash, composite_score, weights,
       score_returns, score_robustness, score_cost, score_regimes, result_json)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    result.algoHash,
    result.symbol,
    result.timeframe,
    result.dateRange.start,
    result.dateRange.end,
    JSON.stringify(result.costModel),
    costHash,
    result.compositeScore,
    JSON.stringify(result.weights),
    result.scores.returns.score,
    result.scores.robustness.score,
    result.scores.cost.score,
    result.scores.regimes.score,
    JSON.stringify(result),
  );

  return id;
}

/**
 * Load a BenchmarkResult by id.
 * @returns {BenchmarkResult | null}
 */
export function loadResult(id, dbPath) {
  const db = getDb(dbPath);
  const row = db.prepare('SELECT result_json FROM benchmarks WHERE id = ?').get(id);
  return row ? JSON.parse(row.result_json) : null;
}

/**
 * List recent benchmark runs, newest first.
 * @returns {BenchmarkSummary[]}
 */
export function listResults({ limit = 50, symbol, algoHash } = {}, dbPath) {
  const db = getDb(dbPath);
  let sql = `
    SELECT id, algo_hash, symbol, timeframe, date_start, date_end,
           composite_score, score_returns, score_robustness, score_cost, score_regimes, created_at
    FROM benchmarks
  `;
  const conditions = [];
  const params = [];

  if (symbol) { conditions.push('symbol = ?'); params.push(symbol); }
  if (algoHash) { conditions.push('algo_hash = ?'); params.push(algoHash); }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Tag a benchmark run for easy filtering.
 */
export function tagResult(id, tag, dbPath) {
  const db = getDb(dbPath);
  db.prepare('INSERT OR IGNORE INTO benchmark_tags (benchmark_id, tag) VALUES (?, ?)').run(id, tag);
}

export function hashSource(source) {
  return createHash('sha256').update(source).digest('hex').slice(0, 16);
}

function hashJson(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}
