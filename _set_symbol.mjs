import { setSymbol } from './src/core/chart.js';
try {
  const result = await setSymbol({ symbol: 'NSE:NIFTY' });
  console.log(JSON.stringify(result, null, 2));
} catch(e) {
  console.error('Error:', e.message);
}
