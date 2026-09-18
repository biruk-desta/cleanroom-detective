import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import wasmURL from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createCaseEngine } from './large-engine.mjs';
import { parseCSVChunks } from './csv-stream.mjs';
import { wrapSqlite } from './sqlite-browser.mjs';
import { availableChecks, validateRules } from './audit.ts';

const MiB = 1024 ** 2,
  MAX_FILE = 2 * 1024 ** 3,
  CHUNK = 8 * MiB;
const hash = (value) =>
  bytesToHex(
    sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value),
  );
let engine,
  pool,
  meta,
  originals,
  active = null;
const cases = new Map();
const sendJob = (job) => self.postMessage({ event: 'job', job });
const getJob = (id) => {
  const row = meta.prepare('SELECT payload FROM jobs WHERE id=?').get(id);
  if (!row) throw new Error('This file is no longer in browser storage.');
  return JSON.parse(row.payload);
};
const saveJob = (job, publish = true) => {
  meta
    .prepare('INSERT OR REPLACE INTO jobs VALUES (?,?)')
    .run(job.id, JSON.stringify(job));
  if (publish) sendJob(job);
  return job;
};
const getJobs = () =>
  meta
    .prepare('SELECT payload FROM jobs ORDER BY id')
    .all()
    .map((r) => JSON.parse(r.payload));
const caseDB = (id) => {
  if (!cases.has(id)) cases.set(id, engine.openCase(`/${id}.sqlite`));
  return cases.get(id);
};
async function original(id, create = false) {
  return originals.getFileHandle(`${id}.csv`, { create });
}
async function* blobChunks(file) {
  for (let offset = 0; offset < file.size; offset += 256 * 1024)
    yield new Uint8Array(
      await file.slice(offset, offset + 256 * 1024).arrayBuffer(),
    );
}
function idle() {
  if (active)
    throw new Error('Wait for the current task to finish, or stop it first.');
}
async function remove(id) {
  idle();
  cases.get(id)?.close();
  cases.delete(id);
  for (const suffix of ['', '-journal', '-wal', '-shm'])
    pool.unlink(`/${id}.sqlite${suffix}`);
  await originals.removeEntry(`${id}.csv`).catch((error) => {
    if (error.name !== 'NotFoundError') throw error;
  });
  meta.prepare('DELETE FROM chunks WHERE job_id=?').run(id);
  meta.prepare('DELETE FROM jobs WHERE id=?').run(id);
  self.postMessage({ event: 'removed', id });
}
async function init(cancelId) {
  if (!navigator.storage?.getDirectory || !navigator.locks)
    throw new Error(
      'Large files need a recent desktop Chrome or Edge browser. The small-file demo still works.',
    );
  // Keep one owner of the synchronous OPFS pool across tabs.
  await new Promise((resolve, reject) => {
    void navigator.locks.request(
      'cleanroom-large-workspace-v1',
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          reject(
            new Error(
              'Your large-file workspace is already open in another tab. Close that tab, then try again.',
            ),
          );
          return;
        }
        resolve();
        await new Promise(() => {});
      },
    );
  });
  const sqlite3 = await sqlite3InitModule({
    locateFile: () => wasmURL,
    print: () => {},
    printErr: () => {},
  });
  pool = await sqlite3.installOpfsSAHPoolVfs({
    name: 'cleanroom-sah-v1',
    directory: '/cleanroom-sah-v1',
    initialCapacity: 16,
  });
  engine = createCaseEngine({
    openDatabase: (path) =>
      wrapSqlite(sqlite3, new pool.OpfsSAHPoolDb(path, 'c')),
    hash,
    randomUUID: () => crypto.randomUUID(),
    journalMode: 'DELETE',
    readCSV: (file, options) => parseCSVChunks(blobChunks(file), options),
  });
  meta = wrapSqlite(sqlite3, new pool.OpfsSAHPoolDb('/workspace.sqlite', 'c'));
  meta.exec(
    'PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS chunks(job_id TEXT NOT NULL,offset INTEGER NOT NULL,length INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(job_id,offset));',
  );
  const root = await navigator.storage.getDirectory();
  originals = await root.getDirectoryHandle('cleanroom-originals-v1', {
    create: true,
  });
  for (const job of getJobs()) {
    if (['working', 'queued'].includes(job.state))
      saveJob({
        ...job,
        state: job.id === cancelId ? 'cancelled' : 'failed',
        phase: 'Paused',
        error:
          job.id === cancelId
            ? 'Stopped. Retry whenever you are ready.'
            : 'This tab closed during a task. Retry to continue.',
      });
    if (job.expires < Date.now()) await remove(job.id);
  }
  return {
    session: {
      username: 'this browser',
      maxUploadBytes: MAX_FILE,
      chunkBytes: CHUNK,
      retentionHours: 24,
    },
    jobs: getJobs(),
  };
}
function queue(job, task, payload = {}) {
  idle();
  active = job.id;
  saveJob({
    ...job,
    state: 'working',
    phase: task === 'import' ? 'Reading your file' : 'Checking your file',
    task,
    payload,
    error: null,
  });
  setTimeout(async () => {
    let db,
      last = 0;
    try {
      db = caseDB(job.id);
      db.exec(
        `PRAGMA max_page_count=${Math.floor((job.databaseBudget ?? job.size * 8 + 128 * MiB) / 4096)}`,
      );
      const progress = (update) => {
        if (Date.now() - last < 400) return;
        last = Date.now();
        saveJob({
          ...getJob(job.id),
          phase: update.phase,
          records: update.records ?? getJob(job.id).records,
          progress: update.bytes ?? getJob(job.id).progress,
        });
      };
      let summary;
      if (task === 'import') {
        const file = await (await original(job.id)).getFile();
        if (file.size !== job.size)
          throw new Error(
            'The file copy is incomplete. Resume or open a fresh copy.',
          );
        await engine.importCase(db, file, job.name, progress);
        summary = engine.caseSummary(db);
      } else if (task === 'audit')
        summary = engine.auditCase(db, payload.rules, progress);
      else if (task === 'decide')
        summary = engine.decideCase(db, payload, progress);
      else if (task === 'bulk')
        summary = engine.bulkCase(db, payload, progress);
      else if (task === 'undo') summary = engine.undoCase(db, progress);
      else throw new Error('Unknown task.');
      saveJob({
        ...getJob(job.id),
        summary,
        records: summary.sourceRecords,
        progress: job.size,
        state: task === 'import' ? 'ready' : 'complete',
        phase: 'Ready to review',
        error: null,
      });
    } catch (error) {
      const recover = ['decide', 'undo', 'bulk'].includes(task) && job.summary;
      saveJob({
        ...getJob(job.id),
        state: recover ? 'complete' : 'failed',
        phase: 'Needs attention',
        error:
          error.message +
          (/SQLITE_FULL|I\/O|quota/i.test(error.message)
            ? ' Free some disk space or remove an older file, then retry.'
            : ''),
      });
    } finally {
      active = null;
    }
  }, 0);
  return getJob(job.id);
}
async function route(path, method = 'GET', body) {
  const url = new URL(path, 'https://workspace.local/');
  if (url.pathname === '/session')
    return {
      username: 'this browser',
      maxUploadBytes: MAX_FILE,
      chunkBytes: CHUNK,
      retentionHours: 24,
    };
  if (url.pathname === '/jobs' && method === 'GET') return getJobs();
  if (url.pathname === '/jobs' && method === 'POST') {
    idle();
    if (
      !body?.name?.toLowerCase().endsWith('.csv') ||
      !Number.isSafeInteger(body.size) ||
      body.size < 1 ||
      body.size > MAX_FILE
    )
      throw new Error('Choose a CSV up to 2 GB.');
    const jobs = getJobs();
    if (jobs.length >= 3)
      throw new Error(
        'Keep up to three large files in this browser. Remove one before adding another.',
      );
    const estimate = await navigator.storage.estimate();
    const held = jobs.reduce((sum, j) => sum + j.reserved, 0);
    const available =
      (estimate.quota ?? 0) - Math.max(estimate.usage ?? 0, held);
    // Reserve the original, a bounded database, and room for a rollback journal.
    // Use available quota instead of rejecting every long-record file below a fixed 12x ratio.
    const reserve = Math.min(body.size * 12 + 128 * MiB, available);
    if (reserve < body.size * 5 + 128 * MiB)
      throw new Error(
        `This file needs at least ${((body.size * 5 + 128 * MiB) / 1024 ** 3).toFixed(1)} GB of browser working space. About ${(Math.max(0, available) / 1024 ** 3).toFixed(1)} GB is available. Remove older files or free disk space.`,
      );
    const databaseBudget = Math.floor((reserve - body.size - 128 * MiB) / 2);
    const id = crypto.randomUUID();
    await original(id, true);
    return saveJob({
      id,
      name: body.name.slice(0, 120),
      size: body.size,
      offset: 0,
      reserved: reserve,
      databaseBudget,
      created: Date.now(),
      expires: Date.now() + 24 * 60 * 60_000,
      state: 'uploading',
      phase: 'Ready to open',
      records: 0,
      progress: 0,
      summary: null,
      task: '',
      error: null,
    });
  }
  const match = /^\/jobs\/([a-f0-9-]+)(?:\/([a-z]+))?$/.exec(url.pathname);
  if (!match) throw new Error('Unknown workspace action.');
  const job = getJob(match[1]),
    action = match[2] || '';
  if (!action && method === 'GET') return job;
  if (!action && method === 'DELETE') {
    await remove(job.id);
    return { ok: true };
  }
  if (action === 'chunks')
    return meta
      .prepare(
        'SELECT offset,length,sha256 FROM chunks WHERE job_id=? ORDER BY offset',
      )
      .all(job.id);
  if (action === 'finish') {
    if (job.state !== 'uploading' || job.offset !== job.size)
      throw new Error('Finish copying the file first.');
    return queue(job, 'import');
  }
  if (action === 'retry') {
    if (!['failed', 'cancelled'].includes(job.state))
      throw new Error('This file does not need retrying.');
    const task = ['decide', 'undo', 'bulk'].includes(job.task)
      ? 'audit'
      : job.task;
    return queue(
      job,
      task,
      task === 'audit'
        ? {
            rules: job.task === 'audit' ? job.payload.rules : job.summary.rules,
          }
        : job.payload,
    );
  }
  if (action === 'check') {
    if (!['ready', 'complete'].includes(job.state))
      throw new Error('Wait until the file is ready.');
    validateRules(body.rules, job.summary.headers);
    if (!availableChecks(body.rules).length)
      throw new Error('Choose at least one check.');
    if (job.summary.decisions)
      throw new Error('Undo decisions before changing checks.');
    return queue(job, 'audit', body);
  }
  if (['decide', 'undo', 'bulk'].includes(action)) {
    if (job.state !== 'complete')
      throw new Error('Finish checking the file first.');
    return queue(job, action, body);
  }
  idle();
  const db = caseDB(job.id);
  if (action === 'findings')
    return engine.listFindings(db, {
      afterRow: Number(url.searchParams.get('afterRow')) || 0,
      afterPriority: Number(url.searchParams.get('afterPriority') ?? 1000),
      afterId: url.searchParams.get('afterId') || '',
      filter: url.searchParams.get('filter') || 'pending',
      limit: 30,
    });
  if (action === 'rows') {
    let related = null;
    if (url.searchParams.has('relatedRow')) {
      related = db
        .prepare('SELECT idkey FROM rows WHERE id=?')
        .get(Number(url.searchParams.get('relatedRow')))?.idkey;
      if (related === null || related === undefined)
        throw new Error('Related rows not found.');
    }
    return engine.listRows(db, {
      after: Number(url.searchParams.get('after')) || 0,
      related,
      limit: 50,
    });
  }
  if (action === 'decisions')
    return db
      .prepare(
        'SELECT seq,action,note,at,payload FROM decisions ORDER BY seq DESC LIMIT 30',
      )
      .all()
      .map((d) => ({
        ...d,
        finding: JSON.parse(d.payload),
        payload: undefined,
      }));
  throw new Error('Unknown workspace action.');
}
async function chunk(id, offset, blob) {
  idle();
  const job = getJob(id);
  if (
    job.state !== 'uploading' ||
    offset !== job.offset ||
    blob.size > CHUNK ||
    blob.size < 1 ||
    offset + blob.size > job.size
  )
    throw new Error('The copy position changed. Resume using the same file.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const handle = await (await original(id)).createSyncAccessHandle();
  try {
    handle.truncate(offset);
    let written = 0;
    while (written < bytes.length) {
      const n = handle.write(bytes.subarray(written), { at: offset + written });
      if (!n) throw new Error('Disk is full.');
      written += n;
    }
    handle.flush();
    meta.exec('BEGIN IMMEDIATE');
    try {
      meta
        .prepare('INSERT INTO chunks VALUES (?,?,?,?)')
        .run(id, offset, bytes.length, hash(bytes));
      saveJob(
        {
          ...job,
          offset: offset + bytes.length,
          progress: offset + bytes.length,
        },
        false,
      );
      meta.exec('COMMIT');
      sendJob(getJob(id));
    } catch (error) {
      meta.exec('ROLLBACK');
      throw error;
    }
  } finally {
    handle.close();
  }
  return { offset: offset + bytes.length };
}
const escape = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
function* report(db) {
  const s = engine.caseSummary(db);
  yield `<!doctype html><meta charset="utf-8"><title>Review report</title><h1>${escape(s.name)}</h1><p>${s.records} rows; ${s.applied} approved changes; ${s.pending} items awaiting review. Kept values were not verified corrections.</p>`;
  for (const d of db
    .prepare('SELECT payload,action,note FROM decisions ORDER BY seq')
    .iterate()) {
    const f = JSON.parse(d.payload);
    yield `<article><h2>Row ${f.rowId}: ${escape(f.title)}</h2><p>${escape(d.action)}: ${escape(d.note)}</p><pre>${escape(JSON.stringify(f.patch ?? {}, null, 2))}</pre></article>`;
  }
  for (const r of db
    .prepare('SELECT payload FROM findings ORDER BY row_id,id')
    .iterate()) {
    const f = JSON.parse(r.payload);
    yield `<article><h2>Row ${f.rowId}: ${escape(f.title)}</h2><p>${escape(f.detail)}</p><ul>${f.evidence.map((e) => `<li>${escape(e)}</li>`).join('')}</ul></article>`;
  }
}
async function download(id, kind, handle) {
  idle();
  const job = getJob(id);
  if (!['ready', 'complete'].includes(job.state))
    throw new Error('Finish the current task before downloading.');
  active = id;
  let stream;
  try {
    stream = await handle.createWritable();
    if (kind === 'original') {
      for await (const bytes of blobChunks(
        await (await original(id)).getFile(),
      ))
        await stream.write(bytes);
    } else {
      const db = caseDB(id);
      const iterator =
        kind === 'updated'
          ? engine.exportCSV(db)
          : kind === 'unresolved'
            ? engine.exportUnresolved(db)
            : kind === 'changes'
              ? engine.exportDecisions(db)
              : report(db);
      let block = '';
      for (const line of iterator) {
        block += line;
        if (block.length >= MiB) {
          await stream.write(block);
          block = '';
        }
      }
      if (block) await stream.write(block);
    }
    await stream.close();
    return { ok: true };
  } catch (error) {
    await stream?.abort().catch(() => {});
    throw error;
  } finally {
    active = null;
  }
}
let initializing,
  dispatch = Promise.resolve();
async function handleMessage({ data }) {
  const { id, type, args } = data;
  try {
    let result;
    if (type === 'init') {
      initializing = init(args?.cancelId);
      result = await initializing;
    } else {
      await initializing;
      if (type === 'request') result = await route(...args);
      else if (type === 'chunk') result = await chunk(...args);
      else if (type === 'download') result = await download(...args);
      else throw new Error('Unknown request.');
    }
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
}
self.onmessage = (event) => {
  dispatch = dispatch.then(() => handleMessage(event));
};
