/**
 * Append-only JSONL signal journal.
 *
 * Each line is one JSON-serialised SignalObject. Never deletes or overwrites entries.
 * Accepted and rejected signals are both logged — the `confidence` and `decision`
 * fields distinguish them.
 *
 * @module signalJournal
 */

import { appendFile, readFile } from 'fs/promises';

/**
 * Appends one signal as a JSON line to the log file.
 * Creates the file if it does not exist.
 *
 * @param {object} signal - SignalObject
 * @param {string} logPath - absolute or relative path to the .jsonl file
 * @returns {Promise<void>}
 */
export async function append(signal, logPath) {
  await appendFile(logPath, JSON.stringify(signal) + '\n', 'utf8');
}

/**
 * Reads all signals from the log file.
 * Returns an empty array if the file does not exist.
 *
 * @param {string} logPath
 * @returns {Promise<object[]>} array of parsed SignalObjects (oldest first)
 */
export async function readAll(logPath) {
  let content;
  try {
    content = await readFile(logPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return content
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
}
