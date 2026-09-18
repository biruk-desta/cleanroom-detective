import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
  randomUUID,
} from 'node:crypto';
import { promisify } from 'node:util';
import {
  mkdir,
  readFile,
  stat,
  statfs,
  open,
  rm,
  truncate,
} from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { availableChecks, validateRules } from '../lib/audit.ts';
import {
  openCase,
  caseSummary,
  listFindings,
  listRows,
  exportCSV,
  exportDecisions,
} from './database.mjs';

const derive = promisify(scrypt);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
export async function passwordRecord(username, password) {
  if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(username) || password.length < 12)
    throw new Error(
      'Use a simple account name and a password with at least 12 characters.',
    );
  const salt = randomBytes(16).toString('hex');
  return {
    username,
    salt,
    digest: (await derive(password, salt, 64)).toString('hex'),
  };
}
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
async function jsonBody(req, max = 64 * 1024) {
  let bytes = 0;
  const parts = [];
  for await (const part of req) {
    bytes += part.length;
    if (bytes > max) fail(413, 'Request is too large.');
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    fail(400, 'Send a valid JSON request.');
  }
}
const safeName = (name) =>
  String(name)
    .replace(/[^a-zA-Z0-9_. -]/g, '_')
    .slice(0, 120) || 'spreadsheet.csv';
/** @param {{dataDir: string, origin: string, users: {username: string, salt: string, digest: string}[], publicDir?: string, maxUploadBytes?: number, maxReservedBytes?: number, retentionHours?: number, chunkBytes?: number, workerMemoryMB?: number}} options */
export async function makeService({
  dataDir,
  publicDir,
  origin,
  users,
  maxUploadBytes = 2 * GiB,
  maxReservedBytes = 60 * GiB,
  retentionHours = 24,
  chunkBytes = 8 * MiB,
  workerMemoryMB = 512,
}) {
  if (!dataDir || !origin || !Array.isArray(users) || !users.length)
    throw new Error('Configure dataDir, origin and at least one account.');
  if (new URL(origin).origin !== origin)
    throw new Error(
      'PUBLIC_ORIGIN must be a URL origin with no path or trailing slash.',
    );
  if (
    !Number.isSafeInteger(maxUploadBytes) ||
    maxUploadBytes < MiB ||
    maxUploadBytes > 10 * GiB
  )
    throw new Error('Configure a per-file limit between 1 MB and 10 GB.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'service.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS upload_chunks(job_id TEXT NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(job_id,offset));
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL, task TEXT, payload TEXT, error TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, records INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, summary TEXT);
  `);
  db.prepare(
    "UPDATE jobs SET state='failed',error='The service restarted during this task. Retry to continue.',phase='Interrupted' WHERE state='working'",
  ).run();
  const tasks = new Map(),
    uploading = new Set(),
    downloading = new Map();
  const attempts = new Map();
  let stopping = false;
  const casePath = (id) => join(dataDir, id, 'case.sqlite');
  const originalPath = (id) => join(dataDir, id, 'original.csv');
  const getJob = (id) => db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  function clientJob(job) {
    const {
      owner: _owner,
      reserved: _reserved,
      payload: _payload,
      ...safe
    } = job;
    return { ...safe, summary: job.summary ? JSON.parse(job.summary) : null };
  }
  function account(req) {
    const token = /(?:^|;\s*)cleanroom_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie ?? '',
    )?.[1];
    if (!token) fail(401, 'Sign in to use the large-file workspace.');
    const session = db
      .prepare('SELECT owner FROM sessions WHERE token=? AND expires>?')
      .get(sha(token), Date.now());
    if (!session || !users.some((u) => u.username === session.owner))
      fail(401, 'Your session expired. Sign in again.');
    return session.owner;
  }
  function owned(id, owner) {
    if (!/^[a-f0-9-]{36}$/.test(id)) fail(404, 'File not found.');
    const job = getJob(id);
    if (!job || job.owner !== owner) fail(404, 'File not found.');
    return job;
  }
  function idle(job) {
    if (
      ['working', 'queued', 'deleting'].includes(job.state) ||
      tasks.has(job.id) ||
      uploading.has(job.id) ||
      downloading.get(job.id)
    )
      fail(409, 'This file is busy. Wait for the current task to finish.');
  }
  async function removeJob(job) {
    db.prepare("UPDATE jobs SET state='deleting' WHERE id=?").run(job.id);
    const worker = tasks.get(job.id);
    if (worker) {
      await worker.terminate();
      tasks.delete(job.id);
    }
    await rm(join(dataDir, job.id), { recursive: true, force: true });
    db.prepare('DELETE FROM upload_chunks WHERE job_id=?').run(job.id);
    db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
  }
  async function cleanup() {
    for (const job of db
      .prepare('SELECT * FROM jobs WHERE expires<? OR state=?')
      .all(Date.now(), 'deleting')) {
      if (
        !uploading.has(job.id) &&
        !downloading.get(job.id) &&
        !tasks.has(job.id)
      )
        await removeJob(job);
    }
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    for (const [key, entry] of attempts)
      if (entry.until < Date.now()) attempts.delete(key);
  }
  async function launchNext() {
    if (stopping || tasks.size) return;
    const job = db
      .prepare(
        "SELECT * FROM jobs WHERE state='queued' ORDER BY created,id LIMIT 1",
      )
      .get();
    if (!job) return;
    db.prepare(
      "UPDATE jobs SET state='working',error=NULL,phase=? WHERE id=?",
    ).run(
      job.task === 'import' ? 'Reading your file' : 'Checking your file',
      job.id,
    );
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: {
        task: job.task,
        database: casePath(job.id),
        source: originalPath(job.id),
        name: job.name,
        maxDbBytes: job.size * 8 + 128 * MiB,
        ...JSON.parse(job.payload || '{}'),
      },
      resourceLimits: { maxOldGenerationSizeMb: workerMemoryMB },
    });
    tasks.set(job.id, worker);
    let ended = false;
    const finish = (message, error) => {
      if (ended) return;
      ended = true;
      const current = getJob(job.id);
      if (
        !current ||
        current.state === 'deleting' ||
        current.state === 'cancelled'
      )
        return;
      if (error) {
        const recover =
          ['decide', 'undo'].includes(job.task) && current.summary;
        db.prepare('UPDATE jobs SET state=?,phase=?,error=? WHERE id=?').run(
          recover ? 'complete' : 'failed',
          'Task needs attention',
          error,
          job.id,
        );
      } else {
        let summary;
        if (job.task === 'import') {
          const c = openCase(casePath(job.id), true);
          try {
            summary = caseSummary(c);
          } finally {
            c.close();
          }
        } else summary = message.result;
        db.prepare(
          'UPDATE jobs SET state=?,phase=?,summary=?,records=?,progress=?,error=NULL WHERE id=?',
        ).run(
          job.task === 'import' ? 'ready' : 'complete',
          job.task === 'import' ? 'Your file is ready' : 'Ready to review',
          JSON.stringify(summary),
          summary.sourceRecords,
          job.size,
          job.id,
        );
      }
    };
    worker.on('message', (message) => {
      if (message.type === 'progress')
        db.prepare(
          'UPDATE jobs SET phase=?,records=COALESCE(?,records),progress=COALESCE(?,progress) WHERE id=?',
        ).run(
          message.phase,
          message.records ?? null,
          message.bytes ?? null,
          job.id,
        );
      else if (message.type === 'done') finish(message);
      else if (message.type === 'error') finish(null, message.error);
    });
    worker.on('error', (error) => finish(null, error.message));
    worker.on('exit', (code) => {
      if (!ended)
        finish(
          null,
          `The background task stopped${code ? ' unexpectedly' : ''}. Retry to continue.`,
        );
      tasks.delete(job.id);
      void launchNext();
    });
  }
  function queue(job, task, payload = {}) {
    job = getJob(job.id);
    if (!job) fail(404, 'File not found.');
    idle(job);
    const allowed =
      task === 'import'
        ? ['uploading', 'failed', 'cancelled']
        : task === 'audit'
          ? ['ready', 'complete', 'failed', 'cancelled']
          : ['complete'];
    if (!allowed.includes(job.state))
      fail(409, 'The file changed. Refresh and try again.');
    db.prepare(
      "UPDATE jobs SET state='queued',task=?,payload=?,phase='Waiting for the current file to finish',error=NULL WHERE id=?",
    ).run(task, JSON.stringify(payload), job.id);
    void launchNext();
  }
  const json = (res, status, value) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify(value));
  };
  async function download(req, res, job, kind) {
    idle(job);
    if (
      job.offset !== job.size ||
      !['ready', 'complete', 'failed', 'cancelled'].includes(job.state)
    )
      fail(409, 'Finish uploading before downloading.');
    if (kind !== 'original' && !['ready', 'complete'].includes(job.state))
      fail(
        409,
        'Finish or retry the current check before downloading updated results.',
      );
    downloading.set(job.id, (downloading.get(job.id) ?? 0) + 1);
    let caseDb;
    try {
      const filename =
        kind === 'original'
          ? safeName(job.name)
          : kind === 'changes'
            ? 'changes.csv'
            : kind === 'report'
              ? 'review-report.html'
              : safeName(job.name).replace(/\.csv$/i, '') + '-updated.csv';
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename}"`,
      );
      res.setHeader(
        'Content-Type',
        kind === 'report'
          ? 'text/html; charset=utf-8'
          : 'text/csv; charset=utf-8',
      );
      if (kind === 'original')
        await pipeline(createReadStream(originalPath(job.id)), res);
      else {
        caseDb = openCase(casePath(job.id), true);
        caseDb.exec('BEGIN');
        let iterable;
        if (kind === 'changes') iterable = exportDecisions(caseDb);
        else if (kind === 'report') iterable = exportReport(caseDb, job);
        else iterable = exportCSV(caseDb);
        await pipeline(Readable.from(iterable), res);
      }
    } finally {
      if (caseDb) caseDb.close();
      downloading.delete(job.id);
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url, origin),
        path = url.pathname;
      if (path === '/healthz') return json(res, 200, { status: 'ok' });
      if (!path.startsWith('/api/large/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD')
          fail(405, 'Method not allowed.');
        if (!publicDir) fail(404, 'The website build is not installed.');
        const relative = path.startsWith('/cleanroom-detective/')
          ? path.slice('/cleanroom-detective/'.length)
          : path.slice(1);
        const target = resolve(publicDir, relative || 'index.html');
        if (!target.startsWith(resolve(publicDir) + '/'))
          fail(404, 'Not found.');
        const types = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.pdf': 'application/pdf',
          '.tex': 'text/plain',
          '.woff2': 'font/woff2',
        };
        if (!types[extname(target)]) fail(404, 'Not found.');
        const info = await stat(target).catch(() => null);
        if (!info?.isFile()) fail(404, 'Not found.');
        res.setHeader('Content-Type', types[extname(target)]);
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
        );
        if (req.method === 'HEAD') return res.end();
        return await pipeline(createReadStream(target), res);
      }
      if (
        !['GET', 'HEAD'].includes(req.method) &&
        (req.headers.origin !== origin || req.headers['x-cleanroom'] !== '1')
      )
        fail(403, 'Open this workspace directly to make changes.');
      if (path === '/api/large/login' && req.method === 'POST') {
        const body = await jsonBody(req, 4096);
        const key =
          String(body.username).slice(0, 60) + ':' + req.socket.remoteAddress;
        const attempt = attempts.get(key) ?? {
          count: 0,
          until: Date.now() + 15 * 60_000,
        };
        if (attempt.until < Date.now()) {
          attempt.count = 0;
          attempt.until = Date.now() + 15 * 60_000;
        }
        if (attempt.count >= 8 || attempts.size > 2000)
          fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
        attempt.count++;
        attempts.set(key, attempt);
        const user = users.find((u) => u.username === body.username);
        const provided = await derive(
          typeof body.password === 'string' ? body.password.slice(0, 1024) : '',
          user?.salt ?? 'unavailable-account',
          64,
        );
        if (
          !user ||
          !timingSafeEqual(provided, Buffer.from(user.digest, 'hex'))
        )
          fail(401, 'The account name or password is incorrect.');
        attempts.delete(key);
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(
          sha(token),
          user.username,
          Date.now() + 24 * 60 * 60_000,
        );
        res.setHeader(
          'Set-Cookie',
          `cleanroom_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${origin.startsWith('https:') ? '; Secure' : ''}`,
        );
        return json(res, 200, { username: user.username });
      }
      const owner = account(req);
      if (path === '/api/large/session' && req.method === 'GET')
        return json(res, 200, {
          username: owner,
          maxUploadBytes,
          chunkBytes,
          retentionHours,
        });
      if (path === '/api/large/logout' && req.method === 'POST') {
        const token = /cleanroom_session=([a-f0-9]{64})/.exec(
          req.headers.cookie,
        )?.[1];
        if (token)
          db.prepare('DELETE FROM sessions WHERE token=?').run(sha(token));
        res.setHeader(
          'Set-Cookie',
          'cleanroom_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
        );
        return json(res, 200, { ok: true });
      }
      if (path === '/api/large/jobs' && req.method === 'GET')
        return json(
          res,
          200,
          db
            .prepare(
              "SELECT * FROM jobs WHERE owner=? AND state<>'deleting' ORDER BY created DESC",
            )
            .all(owner)
            .map(clientJob),
        );
      if (path === '/api/large/jobs' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (
          typeof body.name !== 'string' ||
          !body.name.toLowerCase().endsWith('.csv')
        )
          fail(400, 'Choose a CSV file.');
        if (
          !Number.isSafeInteger(body.size) ||
          body.size < 1 ||
          body.size > maxUploadBytes
        )
          fail(
            413,
            `Choose a CSV up to ${(maxUploadBytes / GiB).toFixed(1)} GB.`,
          );
        await cleanup();
        const reserved = body.size * 20 + 128 * MiB;
        const space = await statfs(dataDir);
        // Reserve synchronously before yielding, so concurrent requests see it.
        const committed = db
          .prepare('SELECT COALESCE(SUM(reserved),0) AS n FROM jobs')
          .get().n;
        if (
          committed + reserved > maxReservedBytes ||
          Number(space.bavail) * Number(space.bsize) <
            committed + reserved + GiB
        )
          fail(
            507,
            'There is not enough free processing space. Delete an old file or try again later.',
          );
        if (
          db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE owner=?').get(owner)
            .n >= 5
        )
          fail(
            429,
            'You can keep up to five files. Delete one before adding another.',
          );
        const id = randomUUID(),
          created = Date.now();
        db.prepare(
          "INSERT INTO jobs(id,owner,name,size,reserved,state,phase,created,expires) VALUES (?,?,?,?,?,'uploading','Ready to upload',?,?)",
        ).run(
          id,
          owner,
          body.name.slice(0, 120),
          body.size,
          reserved,
          created,
          created + retentionHours * 60 * 60_000,
        );
        try {
          await mkdir(join(dataDir, id), { mode: 0o700 });
          await writeEmpty(originalPath(id));
        } catch (error) {
          await removeJob(getJob(id));
          throw error;
        }
        return json(res, 201, clientJob(getJob(id)));
      }
      const match = /^\/api\/large\/jobs\/([a-f0-9-]+)(?:\/([a-z]+))?$/.exec(
        path,
      );
      if (!match) fail(404, 'Not found.');
      const job = owned(match[1], owner),
        action = match[2] ?? '';
      if (!action && req.method === 'GET')
        return json(res, 200, clientJob(job));
      if (!action && req.method === 'DELETE') {
        if (uploading.has(job.id) || downloading.get(job.id))
          fail(409, 'Stop the upload or download before deleting this file.');
        await removeJob(job);
        void launchNext();
        return json(res, 200, { ok: true });
      }
      if (action === 'chunks' && req.method === 'GET')
        return json(
          res,
          200,
          db
            .prepare(
              'SELECT offset,length,sha256 FROM upload_chunks WHERE job_id=? ORDER BY offset',
            )
            .all(job.id),
        );
      if (action === 'chunk' && req.method === 'PUT') {
        if (job.state !== 'uploading')
          fail(409, 'This file is no longer waiting for upload.');
        if (uploading.has(job.id))
          fail(409, 'Another upload is in progress for this file.');
        const offset = Number(req.headers['upload-offset']);
        const length = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(offset) || offset !== job.offset)
          fail(409, 'Upload position changed. Refresh progress and resume.');
        if (
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > chunkBytes ||
          offset + length > job.size
        )
          fail(413, 'Upload one bounded chunk at a time.');
        uploading.add(job.id);
        const part = join(dataDir, job.id, 'chunk.part');
        let received = 0,
          committed = false;
        const hasher = createHash('sha256');
        const counter = new Transform({
          transform(chunk, _encoding, cb) {
            received += chunk.length;
            if (received > length)
              return cb(new Error('Upload chunk exceeded its declared size.'));
            hasher.update(chunk);
            cb(null, chunk);
          },
        });
        try {
          await pipeline(
            req,
            counter,
            createWriteStream(part, { flags: 'w', mode: 0o600 }),
          );
          if (received !== length)
            fail(400, 'The chunk did not finish. Resume the upload.');
          await truncate(originalPath(job.id), offset);
          await pipeline(
            createReadStream(part),
            createWriteStream(originalPath(job.id), { flags: 'a' }),
          );
          const handle = await open(originalPath(job.id), 'r+');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
          const digest = hasher.digest('hex');
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('UPDATE jobs SET offset=?,progress=? WHERE id=?').run(
              offset + received,
              offset + received,
              job.id,
            );
            db.prepare('INSERT INTO upload_chunks VALUES (?,?,?,?)').run(
              job.id,
              offset,
              received,
              digest,
            );
            db.exec('COMMIT');
            committed = true;
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
          return json(res, 200, { offset: offset + received, sha256: digest });
        } catch (error) {
          if (!committed) await truncate(originalPath(job.id), offset);
          throw error;
        } finally {
          uploading.delete(job.id);
          await rm(part, { force: true });
        }
      }
      if (action === 'finish' && req.method === 'POST') {
        if (job.state !== 'uploading' || job.offset !== job.size)
          fail(409, 'Finish every upload chunk first.');
        queue(job, 'import');
        return json(res, 202, clientJob(getJob(job.id)));
      }
      if (action === 'cancel' && req.method === 'POST') {
        if (!['working', 'queued'].includes(job.state))
          fail(409, 'There is no background task to stop.');
        db.prepare(
          "UPDATE jobs SET state='cancelled',phase='Stopped',error='The task was stopped. Retry when you are ready.' WHERE id=?",
        ).run(job.id);
        const worker = tasks.get(job.id);
        if (worker) await worker.terminate();
        tasks.delete(job.id);
        void launchNext();
        return json(res, 200, clientJob(getJob(job.id)));
      }
      if (action === 'retry' && req.method === 'POST') {
        if (!['failed', 'cancelled'].includes(job.state))
          fail(409, 'This file does not need a retry.');
        const task = ['decide', 'undo'].includes(job.task) ? 'audit' : job.task;
        let payload = JSON.parse(job.payload || '{}');
        if (task === 'audit' && !payload.rules)
          payload = { rules: JSON.parse(job.summary).rules };
        queue(job, task, payload);
        return json(res, 202, clientJob(getJob(job.id)));
      }
      if (action === 'check' && req.method === 'POST') {
        if (!['ready', 'complete'].includes(job.state))
          fail(409, 'Wait until the file is ready.');
        const body = await jsonBody(req);
        const summary = JSON.parse(getJob(job.id)?.summary || 'null');
        if (!summary) fail(409, 'Wait until the file is ready.');
        validateRules(body.rules, summary.headers);
        if (!availableChecks(body.rules).length)
          fail(400, 'Choose at least one check.');
        if (summary.decisions)
          fail(409, 'Undo saved decisions before changing checks.');
        queue(job, 'audit', { rules: body.rules });
        return json(res, 202, clientJob(getJob(job.id)));
      }
      if (action === 'decide' && req.method === 'POST') {
        if (job.state !== 'complete')
          fail(409, 'Finish checking the file first.');
        queue(job, 'decide', { request: await jsonBody(req) });
        return json(res, 202, clientJob(getJob(job.id)));
      }
      if (action === 'undo' && req.method === 'POST') {
        if (job.state !== 'complete')
          fail(409, 'Finish checking the file first.');
        queue(job, 'undo');
        return json(res, 202, clientJob(getJob(job.id)));
      }
      if (action === 'download' && req.method === 'GET') {
        const kind = url.searchParams.get('kind') ?? 'updated';
        if (!['original', 'updated', 'changes', 'report'].includes(kind))
          fail(400, 'Unknown download.');
        return await download(req, res, job, kind);
      }
      if (
        req.method === 'GET' &&
        ['findings', 'rows', 'decisions'].includes(action)
      ) {
        if (!['ready', 'complete'].includes(job.state))
          fail(409, 'Wait for the current task to finish.');
        const caseDb = openCase(casePath(job.id), true);
        try {
          if (action === 'findings') {
            const afterRow = Math.max(
                0,
                Number(url.searchParams.get('afterRow')) || 0,
              ),
              afterId = (url.searchParams.get('afterId') ?? '').slice(0, 500);
            return json(
              res,
              200,
              listFindings(caseDb, {
                afterRow,
                afterId,
                limit: 30,
                filter: url.searchParams.get('filter') ?? 'pending',
                check: url.searchParams.get('check') ?? '',
              }),
            );
          }
          if (action === 'rows') {
            let related = null;
            const relatedRow = Number(url.searchParams.get('relatedRow'));
            if (relatedRow) {
              related =
                caseDb
                  .prepare('SELECT idkey FROM rows WHERE id=?')
                  .get(relatedRow)?.idkey ?? null;
              if (related === null) fail(404, 'Related rows not found.');
            }
            return json(
              res,
              200,
              listRows(caseDb, {
                after: Math.max(0, Number(url.searchParams.get('after')) || 0),
                limit: 50,
                related,
              }),
            );
          }
          return json(
            res,
            200,
            caseDb
              .prepare(
                'SELECT seq,finding_id,action,note,at,payload FROM decisions WHERE seq<? ORDER BY seq DESC LIMIT 30',
              )
              .all(
                Number(url.searchParams.get('before')) ||
                  Number.MAX_SAFE_INTEGER,
              )
              .map((d) => ({
                ...d,
                finding: JSON.parse(d.payload),
                payload: undefined,
              })),
          );
        } finally {
          caseDb.close();
        }
      }
      fail(404, 'Not found.');
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, error instanceof HttpError ? error.status : 400, {
        error:
          error instanceof Error
            ? error.message
            : 'The request could not be completed.',
      });
    }
  });
  server.requestTimeout = 5 * 60_000;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5000;
  const cleaner = setInterval(() => {
    void cleanup().catch(() => {});
  }, 60_000);
  cleaner.unref();
  await cleanup();
  void launchNext();
  return {
    server,
    async close() {
      stopping = true;
      clearInterval(cleaner);
      await Promise.all([...tasks.values()].map((w) => w.terminate()));
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
      db.close();
    },
  };
}
async function writeEmpty(path) {
  const handle = await open(path, 'wx', 0o600);
  await handle.close();
}
const escapeHTML = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
function* exportReport(db, job) {
  const summary = caseSummary(db);
  yield `<!doctype html><html lang="en"><meta charset="utf-8"><title>Review report</title><style>body{font:16px system-ui;max-width:1000px;margin:40px auto;padding:20px;color:#213d36}article{border-top:1px solid #ddd;padding:20px 0}small{color:#596c60}</style><h1>${escapeHTML(job.name)}</h1><p>${summary.records} rows; ${summary.applied} approved changes; ${summary.pending} findings awaiting review. Kept values are reviewed, not verified corrections.</p><h2>Decisions</h2>`;
  for (const d of db
    .prepare('SELECT * FROM decisions ORDER BY seq')
    .iterate()) {
    const f = JSON.parse(d.payload);
    yield `<article><small>Row ${f.rowId} · ${escapeHTML(f.column)} · ${escapeHTML(d.at)}</small><h3>${escapeHTML(f.title)}</h3><p>${escapeHTML(d.action)} — ${escapeHTML(d.note)}</p><pre>${escapeHTML(JSON.stringify(f.patch ?? {}, null, 2))}</pre></article>`;
  }
  yield '<h2>Current findings</h2>';
  for (const raw of db
    .prepare('SELECT payload FROM findings ORDER BY row_id,id')
    .iterate()) {
    const f = JSON.parse(raw.payload);
    yield `<article><small>Row ${f.rowId} · ${escapeHTML(f.column)}</small><h3>${escapeHTML(f.title)}</h3><p>${escapeHTML(f.detail)}</p><ul>${f.evidence.map((e) => `<li>${escapeHTML(e)}</li>`).join('')}</ul></article>`;
  }
  yield '</html>';
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const dataDir = resolve(process.env.CLEANROOM_DATA_DIR || './.large-data');
  const usersFile =
    process.env.CLEANROOM_USERS_FILE || join(dataDir, 'users.json');
  const users = JSON.parse(await readFile(usersFile, 'utf8'));
  const port = Number(process.env.PORT || 8080);
  const app = await makeService({
    dataDir,
    publicDir: resolve(process.env.CLEANROOM_PUBLIC_DIR || './server-dist'),
    origin: process.env.PUBLIC_ORIGIN || `http://localhost:${port}`,
    users,
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 2 * GiB),
    maxReservedBytes: Number(process.env.MAX_RESERVED_BYTES || 60 * GiB),
    retentionHours: Number(process.env.RETENTION_HOURS || 24),
  });
  app.server.listen(port, process.env.HOST || '127.0.0.1', () =>
    process.stdout.write(`Large-file service listening on port ${port}\n`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
}
