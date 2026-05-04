/**
 * Express REST API server for the quant dashboard.
 *
 * Routes:
 *   GET  /api/benchmarks
 *   GET  /api/benchmarks/:id
 *   POST /api/benchmarks/run
 *   POST /api/parse
 *   POST /api/improve
 *
 * In production, serves the compiled web/dist as static files.
 *
 * Start: node src/api/server.js
 * Default port: 4321 (or PORT env var)
 */

import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { router as benchmarkRouter } from './routes/benchmarks.js';
import { router as parserRouter } from './routes/parser.js';
import { router as improveRouter } from './routes/improve.js';
import { getDb } from './db.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ?? 4321;
const WEB_DIST = join(__dir, '..', '..', 'web', 'dist');

const app = express();

app.use(express.json({ limit: '50mb' }));

// CORS for local dev (web/ dev server on 5173, API on 4321)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// API routes
app.use('/api/benchmarks', benchmarkRouter);
app.use('/api/parse', parserRouter);
app.use('/api/improve', improveRouter);

// Health check
app.get('/api/health', (_req, res) => {
  try {
    getDb(); // ensure DB is initialized
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// Serve web/dist in production
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get('*', (_req, res) => res.sendFile(join(WEB_DIST, 'index.html')));
}

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[API]', err);
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, () => {
  console.log(`[API] listening on http://localhost:${PORT}`);
  getDb(); // initialize DB on startup
});

export default app;
