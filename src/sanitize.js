/**
 * Input sanitization utilities for CDP evaluate() calls.
 *
 * All user-supplied values interpolated into JS strings executed via CDP
 * must pass through these helpers to prevent injection attacks.
 */

/**
 * Escape a string for safe interpolation inside single-quoted JS strings.
 * Handles: backslashes, single quotes, newlines, carriage returns,
 * line/paragraph separators, and null bytes.
 */
export function escapeJsString(value) {
  if (value == null) return '';
  const str = String(value);
  return str
    .replace(/\\/g, '\\\\')       // backslashes first
    .replace(/'/g, "\\'")          // single quotes
    .replace(/\n/g, '\\n')         // newlines
    .replace(/\r/g, '\\r')         // carriage returns
    .replace(/\u2028/g, '\\u2028') // line separator
    .replace(/\u2029/g, '\\u2029') // paragraph separator
    .replace(/\0/g, '\\0');        // null bytes
}

/**
 * Validate and coerce a value to a finite number.
 * Throws with a descriptive message if the value is not a valid number.
 */
export function validateNumber(value, name = 'value') {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`${name} must be a finite number, got: ${String(value)}`);
  }
  return num;
}
