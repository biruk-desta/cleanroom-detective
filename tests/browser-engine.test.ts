import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import init from '@sqlite.org/sqlite-wasm';
import { wrapSqlite } from '../lib/sqlite-browser.mjs';
import { createCaseEngine } from '../lib/large-engine.mjs';
import { parseCSVChunks } from '../lib/csv-stream.mjs';
import {
  SAMPLE_CSV,
  SAMPLE_RULES,
  allFindings,
  parseCSV,
} from '../lib/audit.ts';

void test('real SQLite WASM matches the rules engine and survives SQL errors and undo', async () => {
  const sqlite = await init();
  const engine = createCaseEngine({
    openDatabase: () => wrapSqlite(sqlite, new sqlite.oo1.DB(':memory:', 'c')),
    hash: (v: string) => createHash('sha256').update(v).digest('hex'),
    randomUUID,
    journalMode: 'DELETE',
    readCSV: (text: string, options: Record<string, unknown>) =>
      parseCSVChunks(
        (async function* () {
          const bytes = new TextEncoder().encode(text);
          for (let i = 0; i < bytes.length; i += 7)
            yield bytes.subarray(i, i + 7);
        })(),
        options,
      ),
  });
  const db = engine.openCase();
  try {
    await engine.importCase(db, SAMPLE_CSV, 'sample.csv');
    engine.auditCase(db, SAMPLE_RULES);
    const actual = engine
      .listFindings(db, { limit: 100 })
      .map(({ fingerprint: _f, reviewed: _r, ...f }) => f)
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(
      actual,
      allFindings(parseCSV(SAMPLE_CSV), SAMPLE_RULES).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    const before = [...engine.exportCSV(db)].join('');
    const f = engine.listFindings(db, { filter: 'repair' })[0];
    engine.decideCase(db, {
      id: f.id,
      fingerprint: f.fingerprint,
      action: 'apply',
    });
    engine.undoCase(db);
    assert.equal([...engine.exportCSV(db)].join(''), before);
    db.exec('CREATE TABLE recovery(value TEXT UNIQUE)');
    const insert = db.prepare('INSERT INTO recovery VALUES (?)');
    insert.run('one');
    assert.throws(() => insert.run('one'));
    insert.run('two');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recovery').get().n, 2);
    for (const _row of db.prepare('SELECT value FROM recovery').iterate())
      break;
    assert.equal(db.prepare('SELECT value FROM recovery').all().length, 2);
  } finally {
    db.close();
  }
});
