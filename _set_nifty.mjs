import { setSymbol } from './src/core/chart.js';

// Wait for chart API to be ready
for (let i = 0; i < 10; i++) {
  try {
    const result = await setSymbol({ symbol: 'NSE:NIFTY' });
    console.log('Success:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    console.log(`Attempt ${i+1} failed: ${e.message} — retrying...`);
    await new Promise(r => setTimeout(r, 2000));
  }
}
console.error('Failed to set symbol after 10 attempts');
