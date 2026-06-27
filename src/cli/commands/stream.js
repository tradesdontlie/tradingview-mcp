import { register } from '../router.js';
import * as core from '../../core/stream.js';

// Stream commands are special — they don't return JSON, they write JSONL to stdout forever.
// The router's execute() wrapper won't work since these never resolve.
// We override the handler to call the stream directly and never return.

// CLI output sink: JSONL to stdout, banner/errors to stderr. The core stream
// functions only write through this sink, so off-CLI callers (e.g. the MCP stdio
// path) that omit it never touch the process stdio streams.
const cliSink = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

register('stream', {
  description: 'Monitor your local TradingView chart for changes (JSONL output)',
  subcommands: new Map([
    ['quote', {
      description: 'Stream real-time price ticks (OHLCV per bar)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 300)' },
      },
      handler: async (opts) => {
        await core.streamQuote({ interval: opts.interval ? Number(opts.interval) : undefined, sink: cliSink });
        process.exit(0); // unreachable unless stopped
      },
    }],
    ['bars', {
      description: 'Stream last bar updates (emits on new bar or price change)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 500)' },
      },
      handler: async (opts) => {
        await core.streamBars({ interval: opts.interval ? Number(opts.interval) : undefined, sink: cliSink });
        process.exit(0);
      },
    }],
    ['values', {
      description: 'Stream indicator values (RSI, MACD, etc.)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 500)' },
      },
      handler: async (opts) => {
        await core.streamValues({ interval: opts.interval ? Number(opts.interval) : undefined, sink: cliSink });
        process.exit(0);
      },
    }],
    ['lines', {
      description: 'Stream Pine Script line.new() price levels',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name' },
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 1000)' },
      },
      handler: async (opts) => {
        await core.streamLines({ interval: opts.interval ? Number(opts.interval) : undefined, filter: opts.filter, sink: cliSink });
        process.exit(0);
      },
    }],
    ['labels', {
      description: 'Stream Pine Script label.new() annotations',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name' },
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 1000)' },
      },
      handler: async (opts) => {
        await core.streamLabels({ interval: opts.interval ? Number(opts.interval) : undefined, filter: opts.filter, sink: cliSink });
        process.exit(0);
      },
    }],
    ['tables', {
      description: 'Stream Pine Script table.new() data',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name' },
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 2000)' },
      },
      handler: async (opts) => {
        await core.streamTables({ interval: opts.interval ? Number(opts.interval) : undefined, filter: opts.filter, sink: cliSink });
        process.exit(0);
      },
    }],
    ['all', {
      description: 'Stream all panes at once (multi-symbol monitoring)',
      options: {
        interval: { type: 'string', short: 'i', description: 'Poll interval in ms (default 500)' },
      },
      handler: async (opts) => {
        await core.streamAllPanes({ interval: opts.interval ? Number(opts.interval) : undefined, sink: cliSink });
        process.exit(0);
      },
    }],
  ]),
});
