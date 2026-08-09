import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { autoAnalyzeInput, volumeProfileAnalysis, autoSignalAllIndicators, naturalLanguageAnalysis } from '../core/auto-analysis.js';
import { validateEnv, Cache, trackError, getErrorMessage } from '../utils/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const cache = new Cache(60000); // 60s TTL

// Validate environment
const config = validateEnv();

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (process.env.NODE_ENV === 'development') {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    }
  });
  next();
});

// Landing page (homepage)
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'landing.html'));
});

// Analysis dashboard
app.get('/analysis', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    environment: config.env,
    port: config.port,
  });
});

// Auto-analyze endpoint
app.post('/api/analyze', async (req, res) => {
  try {
    const { input, depth = 'comprehensive' } = req.body;
    if (!input) {
      return res.status(400).json({ success: false, error: 'Missing input' });
    }

    const cacheKey = `analyze:${input}:${depth}`;
    let result = cache.get(cacheKey);

    if (!result) {
      result = await autoAnalyzeInput(input, depth);
      cache.set(cacheKey, result);
    }

    res.json(result);
  } catch (err) {
    trackError(err);
    res.status(500).json({ success: false, error: getErrorMessage(err) });
  }
});

// Volume profile
app.post('/api/volume-profile', async (req, res) => {
  try {
    const { symbol, price_high, price_low, volume_data } = req.body;
    if (!symbol || !price_high || !price_low) {
      return res.status(400).json({ success: false, error: 'Missing required fields: symbol, price_high, price_low' });
    }

    const cacheKey = `volume:${symbol}:${price_high}:${price_low}`;
    let result = cache.get(cacheKey);

    if (!result) {
      result = await volumeProfileAnalysis({
        symbol,
        price_high,
        price_low,
        volume_data: volume_data || []
      });
      cache.set(cacheKey, result);
    }

    res.json(result);
  } catch (err) {
    trackError(err);
    res.status(500).json({ success: false, error: getErrorMessage(err) });
  }
});

// All indicators signal
app.post('/api/signals', async (req, res) => {
  try {
    const { symbol, price, volume } = req.body;
    if (!symbol || !price) {
      return res.status(400).json({ success: false, error: 'Missing required fields: symbol, price' });
    }

    const cacheKey = `signals:${symbol}:${price}:${volume || 'default'}`;
    let result = cache.get(cacheKey);

    if (!result) {
      result = await autoSignalAllIndicators(symbol, price, volume || 1500000);
      cache.set(cacheKey, result);
    }

    res.json(result);
  } catch (err) {
    trackError(err);
    res.status(500).json({ success: false, error: getErrorMessage(err) });
  }
});

// Natural language
app.post('/api/natural', async (req, res) => {
  try {
    const { request } = req.body;
    if (!request) {
      return res.status(400).json({ success: false, error: 'Missing request' });
    }

    const result = await naturalLanguageAnalysis(request);
    res.json(result);
  } catch (err) {
    trackError(err);
    res.status(500).json({ success: false, error: getErrorMessage(err) });
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// Error handler middleware (last)
app.use((err, req, res, next) => {
  trackError(err, { path: req.path, method: req.method });
  res.status(500).json({
    success: false,
    error: getErrorMessage(err),
  });
});

app.listen(config.port, () => {
  console.log(`🚀 TradingView Web UI running on http://localhost:${config.port}`);
  console.log(`   Landing: http://localhost:${config.port}`);
  console.log(`   Analysis: http://localhost:${config.port}/analysis`);
  console.log(`   Health: http://localhost:${config.port}/api/health`);
});
