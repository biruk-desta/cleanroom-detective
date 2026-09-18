import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { makeService, passwordRecord } from '../server/service.mjs';
import { SAMPLE_CSV, SAMPLE_RULES } from '../lib/audit.ts';
import type { LargeJob, LargeFinding } from '../lib/large-types.ts';

const origin = 'http://workspace.test';
async function fixture(
  run: (url: string) => Promise<void>,
  maxReservedBytes?: number,
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cleanroom-http-'));
  const app = await makeService({
    dataDir,
    origin,
    maxReservedBytes,
    users: await Promise.all(
      ['alice', 'bob'].map((name) =>
        passwordRecord(name, 'test-password-long-enough'),
      ),
    ),
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const address = app.server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}
function api(url: string, cookie = '') {
  return async (
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${url}/api/large/${path}`, {
      method,
      headers: {
        cookie,
        origin,
        'x-cleanroom': '1',
        ...headers,
        ...(body !== undefined && !Buffer.isBuffer(body)
          ? { 'content-type': 'application/json' }
          : {}),
      },
      ...(body === undefined
        ? {}
        : {
            body: Buffer.isBuffer(body)
              ? new Uint8Array(body)
              : JSON.stringify(body),
          }),
    });
}
async function login(url: string, username: string) {
  const res = await api(url)('login', 'POST', {
    username,
    password: 'test-password-long-enough',
  });
  assert.equal(res.status, 200);
  return api(url, res.headers.get('set-cookie')!.split(';')[0]);
}
async function done(call: ReturnType<typeof api>, id: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const job = (await (await call(`jobs/${id}`)).json()) as LargeJob;
    if (!['queued', 'working'].includes(job.state)) {
      assert(!job.error, job.error ?? '');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Background task did not finish');
}
void test('private HTTP workflow isolates files, resumes chunks, checks, repairs and restores original', async () =>
  fixture(async (url) => {
    const alice = await login(url, 'alice'),
      bob = await login(url, 'bob');
    assert.equal((await api(url)('jobs')).status, 401);
    const data = Buffer.from(SAMPLE_CSV);
    assert.equal(
      (
        await alice(
          'jobs',
          'POST',
          { name: 'test.csv', size: data.length },
          { origin: 'https://untrusted.example' },
        )
      ).status,
      403,
    );
    const created = await alice('jobs', 'POST', {
      name: 'test.csv',
      size: data.length,
    });
    assert.equal(created.status, 201);
    const job = (await created.json()) as LargeJob,
      path = `jobs/${job.id}`;
    for (const suffix of [
      '',
      '/chunks',
      '/findings',
      '/rows',
      '/download?kind=original',
    ])
      assert.equal((await bob(path + suffix)).status, 404);
    assert.equal((await bob(path, 'DELETE')).status, 404);
    assert.equal((await alice(`${path}/finish`, 'POST')).status, 409);
    const first = data.subarray(0, 73),
      second = data.subarray(73);
    assert.equal(
      (await alice(`${path}/chunk`, 'PUT', first, { 'upload-offset': '0' }))
        .status,
      200,
    );
    assert.equal(
      (await alice(`${path}/chunk`, 'PUT', first, { 'upload-offset': '0' }))
        .status,
      409,
    );
    assert.deepEqual(await (await alice(`${path}/chunks`)).json(), [
      {
        offset: 0,
        length: first.length,
        sha256: createHash('sha256').update(first).digest('hex'),
      },
    ]);
    assert.equal(
      (await alice(`${path}/chunk`, 'PUT', second, { 'upload-offset': '73' }))
        .status,
      200,
    );
    assert.equal((await alice(`${path}/finish`, 'POST')).status, 202);
    assert.equal((await done(alice, job.id)).state, 'ready');
    assert.equal(
      (await alice(`${path}/check`, 'POST', { rules: SAMPLE_RULES })).status,
      202,
    );
    const checked = await done(alice, job.id);
    assert.equal(checked.state, 'complete');
    const findings = (await (
      await alice(`${path}/findings?filter=repair`)
    ).json()) as LargeFinding[];
    const repair = findings.find((f) => f.check === 'units')!;
    assert(repair);
    assert.equal(
      (
        await alice(`${path}/decide`, 'POST', {
          id: repair.id,
          fingerprint: repair.fingerprint,
          action: 'apply',
        })
      ).status,
      202,
    );
    assert.equal((await done(alice, job.id)).summary!.applied, 1);
    const changes = await (await alice(`${path}/download?kind=changes`)).text();
    assert.match(changes, /weight/);
    assert.match(changes, /unit/);
    assert.equal((await alice(`${path}/undo`, 'POST')).status, 202);
    assert.equal((await done(alice, job.id)).summary!.applied, 0);
    const original = await (
      await alice(`${path}/download?kind=original`)
    ).arrayBuffer();
    assert.deepEqual(Buffer.from(original), data);
    assert.equal((await alice(`${path}/rows?relatedRow=9999999`)).status, 404);
    assert.equal((await alice(path, 'DELETE')).status, 200);
    assert.equal((await alice(path)).status, 404);
  }));

void test('simultaneous admissions cannot exceed reserved processing space', async () =>
  fixture(
    async (url) => {
      const alice = await login(url, 'alice');
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          alice('jobs', 'POST', { name: 'tiny.csv', size: 32 }),
        ),
      );
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(results.filter((r) => r.status === 507).length, 4);
    },
    129 * 1024 ** 2,
  ));
