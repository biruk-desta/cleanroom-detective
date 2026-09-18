import { createReadStream } from 'node:fs';
import { parseCSVChunks } from '../lib/csv-stream.mjs';
export function readCSV(path, options = {}) {
  return parseCSVChunks(
    createReadStream(path, { highWaterMark: options.chunkSize ?? 256 * 1024 }),
    options,
  );
}
