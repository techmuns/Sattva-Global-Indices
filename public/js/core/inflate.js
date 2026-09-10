/**
 * inflate.js — raw DEFLATE in a browser, and why it is asynchronous.
 *
 * The shared `.xlsx` reader (core/xlsx.js) takes its inflate as an argument
 * because the two runtimes that use it cannot share one. Node has
 * `zlib.inflateRawSync`; a browser has no synchronous inflate at all — only
 * `DecompressionStream`, which is a stream and therefore async.
 *
 * ⚠ `'deflate-raw'`, NOT `'deflate'`. A ZIP member's payload is a RAW DEFLATE
 * stream with no zlib header and no Adler-32 trailer. `'deflate'` expects the
 * header, so it throws on the first two bytes of a real workbook — and the
 * error it throws says nothing about which of the two you wanted. One character
 * apart, and every workbook fails.
 *
 * ⚠ AND THE ABSENCE IS NAMED. `DecompressionStream` is not universal, and a
 * browser without it must say so in those words rather than failing somewhere
 * inside the ZIP reader with a corrupt-archive message that blames the file
 * (§2.4). A workbook that will not open is a different fact from a browser that
 * cannot open it.
 */

export const hasInflate = typeof DecompressionStream === 'function';

export const INFLATE_UNAVAILABLE =
  'This browser has no DecompressionStream, so it cannot unpack an .xlsx here. '
  + 'The workbook is fine — this browser cannot read it. Chrome, Edge and Safari 16.4+ can, '
  + 'or run `node scripts/import-ftse.mjs` against the file instead.';

/**
 * Inflate a raw DEFLATE body to a `Uint8Array`.
 * @param {Uint8Array} body
 * @returns {Promise<Uint8Array>}
 */
export async function inflateRaw(body) {
  if (!hasInflate) throw new Error(INFLATE_UNAVAILABLE);
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
