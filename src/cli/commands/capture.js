import { register } from '../router.js';
import * as core from '../../core/capture.js';

register('screenshot', {
  description: 'Take a screenshot of the chart',
  options: {
    region:    { type: 'string', short: 'r', description: 'Region: full, chart, strategy_tester' },
    output:    { type: 'string', short: 'o', description: 'Custom filename (without .png)' },
    date:      { type: 'string', short: 'd', description: 'Zoom to a specific day before shooting (ISO: 2025-01-15)' },
    timeframe: { type: 'string', short: 't', description: 'Timeframe for zoom window (5, 15, 60, D). Defaults to 5.' },
  },
  handler: (opts) => core.captureScreenshot({
    region: opts.region,
    filename: opts.output,
    date: opts.date,
    timeframe: opts.timeframe,
  }),
});
