import { register } from '../router.js';
import * as core from '../../core/capture.js';

register('screenshot', {
  description: 'Take a screenshot of the chart',
  options: {
    region: { type: 'string', short: 'r', description: 'Region: full, chart, strategy_tester' },
    output: { type: 'string', short: 'o', description: 'Custom filename (without .png)' },
    'wait-for-render': { type: 'boolean', short: 'w', description: 'Wait for the chart canvas to stabilize before capturing. Use after setting symbol or timeframe to avoid stale frames.' },
  },
  handler: (opts) => core.captureScreenshot({
    region: opts.region,
    filename: opts.output,
    waitForRender: opts['wait-for-render'],
  }),
});
