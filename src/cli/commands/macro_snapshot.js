import { readFile } from 'node:fs/promises';
import { register } from '../router.js';
import { captureMacroSnapshot } from '../../core/macro_snapshot.js';

register('macro-snapshot', {
  description: 'Capture a restoring, read-only macro-event chart snapshot',
  options: {
    config: { type: 'string', description: 'Macro-event registry JSON path' },
    'event-id': { type: 'string', description: 'Stable macro event id' },
    phase: { type: 'string', description: 'Capture phase' },
    'as-of-utc': { type: 'string', description: 'UTC capture timestamp' },
  },
  handler: async (opts) => {
    if (!opts.config || !opts['event-id'] || !opts.phase || !opts['as-of-utc']) {
      throw new Error('--config, --event-id, --phase, and --as-of-utc are required');
    }
    const config = JSON.parse(await readFile(opts.config, 'utf8'));
    return captureMacroSnapshot({ config, eventId: opts['event-id'], phase: opts.phase, asOfUtc: opts['as-of-utc'] });
  },
});
