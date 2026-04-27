import { register } from '../router.js';
import * as core from '../../core/profiler.js';

register('profiler', {
  description: 'Pine Profiler tools',
  subcommands: new Map([
    ['enable', {
      description: 'Enable Pine Profiler mode (idempotent)',
      handler: () => core.enableProfiler(),
    }],
    ['disable', {
      description: 'Disable Pine Profiler mode (idempotent)',
      handler: () => core.disableProfiler(),
    }],
    ['get', {
      description: 'Read profiler data (per-line ms / pct, sorted hottest-first)',
      options: {
        top: { type: 'string', short: 't', description: 'Return only the top N most expensive lines' },
      },
      handler: (opts) => core.getProfilerData({
        top_n: opts.top !== undefined ? Number(opts.top) : undefined,
      }),
    }],
    ['warnings', {
      description: 'Read runtime warning/error banners on the chart (e.g., 40s timeout)',
      options: {
        severity: { type: 'string', short: 's', description: 'Filter: all | warning | error (default all)' },
      },
      handler: (opts) => core.getRuntimeWarnings({ severity_filter: opts.severity }),
    }],
    ['probe', {
      description: 'Dump DOM landscape around the profiler — for selector debugging',
      handler: () => core.probeProfilerDom(),
    }],
  ]),
});
