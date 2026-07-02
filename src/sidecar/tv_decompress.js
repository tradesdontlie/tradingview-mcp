/**
 * Hardened decoder for TradingView's compressed strategy-report blobs (T119).
 *
 * TV sends `dataCompressed` as a base64 zlib-deflate stream (magic 78 9c).
 * @mathieuc/tradingview's parseCompressed feeds it to jszip (expecting a ZIP
 * container) and throws "Can't find end of central directory", which crashes
 * the async study listener — and would crash the MCP server. We sniff the magic
 * bytes and inflate accordingly (zlib / gzip / raw deflate), so the strategy
 * reader degrades gracefully instead of taking the process down.
 */
import zlib from 'node:zlib';

/** Decode a base64 compressed-JSON blob into an object. Throws if undecodable. */
export function decodeCompressed(base64) {
  const buf = Buffer.from(base64, 'base64');
  let text;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    text = zlib.gunzipSync(buf).toString('utf8');            // gzip
  } else if (buf[0] === 0x78) {
    text = zlib.inflateSync(buf).toString('utf8');           // zlib (78 01/9c/da)
  } else {
    try { text = zlib.inflateSync(buf).toString('utf8'); }
    catch { text = zlib.inflateRawSync(buf).toString('utf8'); } // raw deflate
  }
  return JSON.parse(text);
}
