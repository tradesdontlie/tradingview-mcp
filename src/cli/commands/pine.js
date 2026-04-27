import { register } from '../router.js';
import * as core from '../../core/pine.js';
import { readFileSync } from 'fs';

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['get', {
      description: 'Get current Pine Script source from editor',
      handler: () => core.getSource(),
    }],
    ['set', {
      description: 'Set Pine Script source (reads stdin or --file)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.setSource({ source });
      },
    }],
    ['compile', {
      description: 'Smart compile: detect button, compile, check errors. --target save|add_to_chart|save_and_add overrides heuristic',
      options: {
        target: { type: 'string', short: 't', description: 'Force button choice: save | add_to_chart | save_and_add' },
      },
      handler: (opts) => core.smartCompile({ target: opts.target }),
    }],
    ['add-to-chart', {
      description: 'Click Add-to-Chart and confirm study replacement',
      options: {
        name: { type: 'string', short: 'n', description: 'Optional script_name to track study_id before/after' },
      },
      handler: (opts) => core.addToChart({ script_name: opts.name }),
    }],
    ['save-and-add', {
      description: 'Save then Add-to-Chart (compound, single round-trip)',
      options: {
        name: { type: 'string', short: 'n', description: 'Optional script_name to track study_id before/after' },
      },
      handler: (opts) => core.saveAndAddToChart({ script_name: opts.name }),
    }],
    ['raw-compile', {
      description: 'Click compile/add button without smart detection',
      handler: () => core.compile(),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.analyze({ source });
      },
    }],
    ['check', {
      description: 'Server-side compile check (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.check({ source });
      },
    }],
    ['save', {
      description: 'Save the current Pine Script (Ctrl+S)',
      handler: () => core.save(),
    }],
    ['new', {
      description: 'Create a new blank Pine Script (indicator, strategy, library)',
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        return core.newScript({ type });
      },
    }],
    ['open', {
      description: 'Open a saved Pine Script by name',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Script name required. Usage: tv pine open "My Script"');
        return core.openScript({ name: positionals.join(' ') });
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      handler: () => core.listScripts(),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors',
      handler: () => core.getErrors(),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      handler: () => core.getConsole(),
    }],
  ]),
});
