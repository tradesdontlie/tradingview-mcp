/**
 * Database initializer for the API server.
 * Re-exports the store's getDb so the API has a single DB handle.
 */

export { getDb, closeDb } from '../../scoring/store.js';
