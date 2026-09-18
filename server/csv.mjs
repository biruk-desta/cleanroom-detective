import { createReadStream } from 'node:fs';

/** Strict streaming CSV reader. Memory is bounded by one record and one input chunk. */
export async function* readCSV(
  path,
  {
    chunkSize = 256 * 1024,
    maxColumns = 200,
    maxCell = 4000,
    progress = () => {},
  } = {},
) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let field = '',
    row = [],
    quoted = false,
    afterQuote = false,
    explicit = false,
    skipLF = false;
  let first = true,
    bytes = 0;
  const finishField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
    if (row.length > maxColumns)
      throw new Error(`Use at most ${maxColumns} columns.`);
  };
  const finishRow = () => {
    finishField();
    const result = explicit || row.some((v) => v !== '') ? row : null;
    row = [];
    explicit = false;
    return result;
  };
  const stream = createReadStream(path, { highWaterMark: chunkSize });
  async function* chunks() {
    for await (const chunk of stream) {
      bytes += chunk.length;
      yield decoder.decode(chunk, { stream: true });
      progress(bytes);
    }
    yield decoder.decode();
  }
  for await (const text of chunks()) {
    for (const c of text) {
      if (first) {
        first = false;
        if (c === '\uFEFF') continue;
      }
      if (skipLF) {
        skipLF = false;
        if (c === '\n') continue;
      }
      if (quoted) {
        if (c === '"') {
          quoted = false;
          afterQuote = true;
        } else field += c;
      } else if (afterQuote && c === '"') {
        quoted = true;
        afterQuote = false;
        field += '"';
      } else {
        if (afterQuote && ![',', '\r', '\n'].includes(c))
          throw new Error('Unexpected text after a quoted CSV field.');
        if (c === '"') {
          if (field !== '')
            throw new Error('A quote appears inside an unquoted field.');
          quoted = true;
          explicit = true;
        } else if (c === ',') {
          explicit = true;
          finishField();
        } else if (c === '\r' || c === '\n') {
          const completed = finishRow();
          skipLF = c === '\r';
          if (completed) yield completed;
        } else field += c;
      }
      if (field.length > maxCell)
        throw new Error(
          `A CSV cell exceeds ${maxCell.toLocaleString()} characters.`,
        );
    }
  }
  if (quoted) throw new Error('A quoted CSV field was not closed.');
  if (field !== '' || row.length || afterQuote) {
    const completed = finishRow();
    if (completed) yield completed;
  }
}
