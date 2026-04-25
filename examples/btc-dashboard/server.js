import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { chart, data } from '../../src/core/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', async (req, res) => {
  try {
    // Attempt to set the symbol to BTCUSD
    try {
      await chart.setSymbol({ symbol: 'BINANCE:BTCUSD' });
    } catch (e) {
      // If we can't set the symbol, it might be that TV is not ready,
      // but let's try to get the quote anyway (maybe it's already on BTC)
    }

    // Get the latest quote
    const quote = await data.getQuote();
    
    // Get OHLCV summary
    const ohlcv = await data.getOhlcv({ summary: true });

    res.json({
      success: true,
      quote,
      ohlcv
    });
  } catch (error) {
    console.error("Error fetching data from TradingView:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch data. Is TradingView running with --remote-debugging-port=9222?"
    });
  }
});

app.listen(PORT, () => {
  console.log(`BTC Dashboard running at http://localhost:${PORT}`);
  console.log(`Make sure TradingView is running with the debug port open.`);
});
