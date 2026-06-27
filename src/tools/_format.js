/**
 * Shared MCP response formatting helper.
 * All tool files use this instead of manually constructing MCP responses.
 */
export function jsonResult(obj, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Wrap a core function as an MCP tool handler, collapsing the repeated
 * try/catch → jsonResult boilerplate. Returns an async handler that calls
 * `fn(args)` and formats the result, surfacing thrown errors as
 * `{ success:false, error }` with the MCP `isError` flag set.
 */
export function wrap(fn) {
  return async (args) => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      return jsonResult({ success: false, error: err.message }, true);
    }
  };
}
