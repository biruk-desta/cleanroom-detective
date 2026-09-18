import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readCSV } from './csv.mjs';
import { createCaseEngine } from '../lib/large-engine.mjs';
export const {
  openCase,
  getMeta,
  setMeta,
  importCase,
  auditCase,
  decideCase,
  bulkCase,
  undoCase,
  caseSummary,
  listFindings,
  listRows,
  exportCSV,
  exportDecisions,
  exportUnresolved,
} = createCaseEngine({
  openDatabase: (path, readOnly) =>
    new DatabaseSync(path, { readOnly, timeout: 5000 }),
  hash: (value) => createHash('sha256').update(value).digest('hex'),
  randomUUID,
  readCSV,
});
