/**
 * Standalone Express server for the ML prediction subsystem — deliberately
 * separate from src/dashboard-server.js (different port, no shared code) per
 * the "independent subsystem" scope decision.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPolling, getCache } from './live_agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.ML_PORT || 4600;
const POLL_INTERVAL_MS = Number(process.env.ML_POLL_MS) || 45_000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/predictions', (req, res) => {
  res.json(getCache());
});

app.listen(PORT, () => {
  console.log(`ML prediction server listening on http://localhost:${PORT}`);
  startPolling({ intervalMs: POLL_INTERVAL_MS });
});
