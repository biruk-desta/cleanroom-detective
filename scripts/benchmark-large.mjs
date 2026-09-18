// Opt-in real >1 GiB HTTP exercise; all generated files are removed afterwards.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, open } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { makeService, passwordRecord } from '../server/service.mjs';
import { inferRules } from '../lib/audit.ts';

const directory = await mkdtemp(join(tmpdir(), 'cleanroom-gigabyte-'));
const source = join(directory, 'benchmark.csv');
const targetBytes = Number(process.env.BENCHMARK_BYTES || 1.1 * 1024 ** 3);
const origin = 'http://benchmark.local';
const started = Date.now();
let records = 0,
  bytes = 0,
  peakRSS = 0,
  app;
const sourceHash = createHash('sha256');
const monitor = setInterval(() => {
  peakRSS = Math.max(peakRSS, process.memoryUsage().rss);
}, 100);
const log = (stage, more = {}) =>
  console.log(
    JSON.stringify({
      stage,
      seconds: Math.round((Date.now() - started) / 1000),
      ...more,
    }),
  );
try {
  function* csv() {
    const header = 'id,total,price,quantity,note\n';
    sourceHash.update(header);
    bytes += Buffer.byteLength(header);
    yield header;
    const note = 'x'.repeat(950);
    while (bytes < targetBytes) {
      let block = '';
      for (let i = 0; i < 2000 && bytes < targetBytes; i++) {
        records++;
        const row = `${records},6,2,${records === 1 ? '' : '3'},${note}\n`;
        bytes += Buffer.byteLength(row);
        block += row;
      }
      sourceHash.update(block);
      yield block;
    }
  }
  await pipeline(Readable.from(csv()), createWriteStream(source));
  const digest = sourceHash.digest('hex');
  log('generated', { bytes, records });
  app = await makeService({
    dataDir: join(directory, 'service'),
    origin,
    users: [await passwordRecord('benchmark', 'local-synthetic-test-only')],
    workerMemoryMB: 512,
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/api/large/`;
  let cookie = '';
  async function api(path, method = 'GET', body, extra = {}) {
    const r = await fetch(url + path, {
      method,
      headers: { origin, cookie, 'x-cleanroom': '1', ...extra },
      ...(body === undefined
        ? {}
        : {
            body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
          }),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r;
  }
  const login = await api('login', 'POST', {
    username: 'benchmark',
    password: 'local-synthetic-test-only',
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const job = await (
    await api('jobs', 'POST', { name: 'benchmark.csv', size: bytes })
  ).json();
  const base = `jobs/${job.id}`;
  const handle = await open(source, 'r');
  try {
    for (let offset = 0; offset < bytes;) {
      const buffer = Buffer.alloc(Math.min(8 * 1024 ** 2, bytes - offset));
      const read = await handle.read(buffer, 0, buffer.length, offset);
      assert.equal(read.bytesRead, buffer.length);
      await api(`${base}/chunk`, 'PUT', buffer, {
        'upload-offset': String(offset),
      });
      offset += buffer.length;
      if (
        Math.floor(offset / (256 * 1024 ** 2)) !==
        Math.floor((offset - buffer.length) / (256 * 1024 ** 2))
      )
        log('upload', { offset });
    }
  } finally {
    await handle.close();
  }
  log('uploaded');
  async function done() {
    let last = '';
    while (true) {
      const j = await (await api(base)).json();
      const state = `${j.state}: ${j.phase}`;
      if (state !== last) {
        log(state, { processedRecords: j.records });
        last = state;
      }
      if (!['queued', 'working'].includes(j.state)) {
        assert(!j.error, j.error);
        await new Promise((r) => setTimeout(r, 50));
        return j;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await api(`${base}/finish`, 'POST');
  assert.equal((await done()).summary.sourceRecords, records);
  const rules = {
    ...inferRules(['id', 'total', 'price', 'quantity', 'note']),
    uniqueIds: true,
    arithmetic: true,
  };
  await api(`${base}/check`, 'POST', { rules });
  const result = await done();
  const findings = await (await api(`${base}/findings`)).json();
  const repair = findings.find((f) => f.check === 'arithmetic' && f.patch);
  assert(repair, JSON.stringify({ rules, result, findings }));
  await api(`${base}/decide`, 'POST', {
    id: repair.id,
    fingerprint: repair.fingerprint,
    action: 'apply',
  });
  assert.equal((await done()).summary.applied, 1);
  const preview = await (await api(`${base}/rows`)).json();
  assert.equal(preview[0].cells[3], '3');
  const updated = await api(`${base}/download?kind=updated`);
  let downloadedBytes = 0,
    newlines = 0;
  for await (const chunk of updated.body) {
    downloadedBytes += chunk.length;
    for (const c of chunk) if (c === 10) newlines++;
  }
  assert.equal(newlines, records + 1);
  await api(`${base}/undo`, 'POST');
  assert.equal((await done()).summary.applied, 0);
  const original = await api(`${base}/download?kind=original`),
    downloadedHash = createHash('sha256');
  for await (const chunk of original.body) downloadedHash.update(chunk);
  assert.equal(downloadedHash.digest('hex'), digest);
  // Independently hash source again: no benchmark-side whole-file buffering.
  const reread = createHash('sha256');
  for await (const chunk of createReadStream(source)) reread.update(chunk);
  assert.equal(reread.digest('hex'), digest);
  log('PASS', {
    bytes,
    records,
    downloadedBytes,
    peakRSS,
    pending: result.summary.pending,
    originalHashVerified: true,
  });
} finally {
  clearInterval(monitor);
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
