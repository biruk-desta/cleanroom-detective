import { parentPort, workerData } from 'node:worker_threads';
import {
  openCase,
  importCase,
  auditCase,
  decideCase,
  bulkCase,
  undoCase,
} from './database.mjs';
const db = openCase(workerData.database);
if (workerData.maxDbBytes)
  db.exec(`PRAGMA max_page_count=${Math.floor(workerData.maxDbBytes / 4096)}`);
let last = 0;
function progress(value) {
  const now = Date.now();
  if (now - last > 400) {
    parentPort.postMessage({ type: 'progress', ...value });
    last = now;
  }
}
try {
  let result;
  if (workerData.task === 'import')
    result = await importCase(db, workerData.source, workerData.name, progress);
  else if (workerData.task === 'audit')
    result = auditCase(db, workerData.rules, progress);
  else if (workerData.task === 'decide')
    result = decideCase(db, workerData.request, progress);
  else if (workerData.task === 'bulk')
    result = bulkCase(db, workerData.request, progress);
  else if (workerData.task === 'undo') result = undoCase(db, progress);
  else throw new Error('Unknown background task.');
  parentPort.postMessage({ type: 'done', result });
} catch (error) {
  parentPort.postMessage({
    type: 'error',
    error:
      error instanceof Error ? error.message : 'The background check failed.',
  });
} finally {
  db.close();
}
