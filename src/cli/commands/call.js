import { z } from 'zod';
import { register } from '../router.js';
import { getToolDefinitions } from '../../tool-definitions.js';

register('call', {
  description: 'Call any current MCP tool with validated JSON parameters and the same permissions (use TV_CDP_TARGET_ID for this process)',
  options: {
    args: { type: 'string', description: 'JSON object of tool parameters; defaults to {}' },
  },
  handler: async (options, positionals) => {
    const definition = getToolDefinitions().find(tool => tool.name === positionals[0]);
    if (!definition) throw new Error('Exact registered tool name required. See the permission administrator or skills/overview.md.');
    const parameters = z.object(definition.parameters).strict().parse(JSON.parse(options.args || '{}'));
    const result = await definition.callback(parameters);
    const text = result.content?.find(block => block.type === 'text')?.text;
    if (result.isError) throw new Error(text || 'Tool returned an MCP error');
    if (text) { try { return JSON.parse(text); } catch { return { success: true, text }; } }
    return result;
  },
});
