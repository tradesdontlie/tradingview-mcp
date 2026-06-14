import { healthCheck } from './src/core/health.js';
try {
  const result = await healthCheck();
  console.log(JSON.stringify(result, null, 2));
} catch(e) {
  console.error('Error:', e.message);
}
