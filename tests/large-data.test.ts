import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openCase,
  importCase,
  auditCase,
  caseSummary,
  listFindings,
  listRows,
  decideCase,
  bulkCase,
  exportUnresolved,
  undoCase,
  exportCSV,
  exportDecisions,
  getMeta,
} from '../server/database.mjs';
import { readCSV } from '../server/csv.mjs';
import {
  parseCSV,
  allFindings,
  SAMPLE_CSV,
  SAMPLE_RULES,
  inferRules,
  type Rules,
} from '../lib/audit.ts';
async function fixture(
  csv: string,
  run: (db: ReturnType<typeof openCase>, path: string) => Promise<void> | void,
) {
  const dir = await mkdtemp(join(tmpdir(), 'cleanroom-test-'));
  const path = join(dir, 'source.csv');
  await writeFile(path, csv);
  const db = openCase(join(dir, 'case.sqlite'));
  try {
    await importCase(db, path, 'test.csv');
    await run(db, path);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}
void test('streaming CSV keeps strict parsing across every byte boundary', async () => {
  const csv =
    '\uFEFFid,note\r\n001,"a,b\nsaid ""hé😀llo"""\r\n,\r\nA,2\r\n\r\n';
  await fixture(csv, async (_db, path) => {
    for (const chunkSize of [1, 2, 3, 7, 31]) {
      const rows = [];
      for await (const row of readCSV(path, { chunkSize })) rows.push(row);
      const expected = parseCSV(csv);
      assert.deepEqual(rows, [
        expected.headers,
        ...expected.rows.map((r) => r.cells),
      ]);
    }
  });
});
void test('disk audit matches all sample findings and restores original after undo', async () => {
  await fixture(SAMPLE_CSV, (db) => {
    auditCase(db, SAMPLE_RULES);
    const actual = listFindings(db, { limit: 100 }).map(
      ({ fingerprint: _f, reviewed: _r, ...f }) => f,
    );
    assert.deepEqual(
      actual.sort((a, b) => a.id.localeCompare(b.id)),
      allFindings(parseCSV(SAMPLE_CSV), SAMPLE_RULES).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    );
    let edits = 0;
    while (true) {
      const next = listFindings(db, { filter: 'repair', limit: 1 })[0];
      if (!next) break;
      decideCase(db, {
        id: next.id,
        fingerprint: next.fingerprint,
        action: 'apply',
      });
      edits++;
    }
    assert.equal(edits, 4);
    assert.equal(caseSummary(db).records, 11);
    assert.equal(caseSummary(db).repairs, 0);
    while (edits--) undoCase(db);
    assert.deepEqual(
      listRows(db, { limit: 100 }).map(({ changed: _c, ...r }) => r),
      parseCSV(SAMPLE_CSV).rows,
    );
    assert.deepEqual(
      parseCSV([...exportCSV(db)].join('')).rows,
      parseCSV(SAMPLE_CSV).rows,
    );
  });
});
void test('duplicate group decisions include all conflicting rows and exact raw IDs', async () => {
  const csv = 'id,v\n001,1\n1,1\nA,x\nA,x\nA,y\na,x\n A ,x\nB,z\nB,z\nB,z';
  await fixture(csv, (db) => {
    const rules = { ...inferRules(['id', 'v']), uniqueIds: true };
    auditCase(db, rules);
    const findings = listFindings(db, { limit: 100 });
    assert.deepEqual(
      findings.filter((f) => f.kind === 'review').map((f) => f.rowId),
      [3, 4, 5],
    );
    assert.deepEqual(
      findings.filter((f) => f.kind === 'repair').map((f) => f.rowId),
      [9, 10],
    );
    const old = findings.find((f) => f.rowId === 10)!;
    const first = findings.find((f) => f.rowId === 9)!;
    decideCase(db, {
      id: first.id,
      fingerprint: first.fingerprint,
      action: 'apply',
    });
    assert.throws(
      () =>
        decideCase(db, {
          id: old.id,
          fingerprint: old.fingerprint,
          action: 'apply',
        }),
      /changed/,
    );
    assert.equal(caseSummary(db).applied, 1);
  });
});
void test('global exact IQR changes invalidate prior keep decisions', async () => {
  await fixture('id,n\na,0\nb,1\nc,2\nd,3\ne,100\ne,100', (db) => {
    const rules: Rules = {
      ...inferRules(['id', 'n']),
      uniqueIds: true,
      outlierColumn: 'n',
      checkOutliers: true,
    };
    auditCase(db, rules);
    const duplicate = listFindings(db, { limit: 100 }).find((f) => f.patch)!;
    decideCase(db, {
      id: duplicate.id,
      fingerprint: duplicate.fingerprint,
      action: 'apply',
    });
    assert.deepEqual(getMeta(db, 'outlierRange'), {
      count: 5,
      q1: 1,
      q3: 3,
      low: -2,
      high: 6,
    });
    const unusual = listFindings(db, { limit: 100 }).find(
      (f) => f.check === 'outliers',
    )!;
    assert.equal(unusual.rowId, 5);
    decideCase(db, {
      id: unusual.id,
      fingerprint: unusual.fingerprint,
      action: 'keep',
    });
    assert.equal(caseSummary(db).pending, 0);
    undoCase(db);
    assert.equal(caseSummary(db).pending, 1);
    undoCase(db);
    assert.equal(listFindings(db, { check: 'outliers' }).length, 0);
  });
});
void test('manual corrections require evidence and rollback when still invalid', async () => {
  await fixture(SAMPLE_CSV, (db) => {
    auditCase(db, SAMPLE_RULES);
    const date = listFindings(db, { check: 'dates' })[0];
    const request = {
      id: date.id,
      fingerprint: date.fingerprint,
      action: 'apply',
      manual: '2026-02-31',
      note: 'Verified against source record',
    };
    assert.throws(() => decideCase(db, request), /still flagged/);
    assert.equal(listRows(db).find((r) => r.id === 6)!.cells[5], '2026-02-30');
    assert.equal(caseSummary(db).decisions, 0);
    decideCase(db, { ...request, manual: '2026-02-28' });
    assert.equal(listRows(db).find((r) => r.id === 6)!.cells[5], '2026-02-28');
    undoCase(db);
    assert.equal(listRows(db).find((r) => r.id === 6)!.cells[5], '2026-02-30');
  });
});
void test('keyset pagination never drops multiple findings on the same row', async () => {
  await fixture(SAMPLE_CSV, (db) => {
    auditCase(db, SAMPLE_RULES);
    const all = listFindings(db, { limit: 100 });
    const seen: string[] = [];
    let afterRow = 0,
      afterId = '';
    while (true) {
      const rows = listFindings(db, { afterRow, afterId, limit: 1 });
      if (!rows.length) break;
      const row = rows[0];
      seen.push(row.id);
      afterRow = row.rowId;
      afterId = row.id;
    }
    assert.deepEqual(
      seen,
      all.map((f) => f.id),
    );
  });
});
void test('keeping a proposed repair exports no unapplied before/after changes', async () => {
  await fixture(SAMPLE_CSV, (db) => {
    auditCase(db, SAMPLE_RULES);
    const unit = listFindings(db, { check: 'units' }).find((f) => f.patch)!;
    decideCase(db, {
      id: unit.id,
      fingerprint: unit.fingerprint,
      action: 'keep',
    });
    const ledger = parseCSV([...exportDecisions(db)].join(''));
    assert.equal(ledger.rows.length, 1);
    const row = ledger.rows[0].cells;
    assert.equal(row[ledger.headers.indexOf('action')], 'keep');
    assert.equal(row[ledger.headers.indexOf('before')], '');
    assert.equal(row[ledger.headers.indexOf('after')], '');
  });
});

void test('bulk preview rejects stale fixes atomically and undo reverses the whole batch', async () => {
  await fixture('id,item\n1, coffee \n2,COFFEE\n3, tea ', (db) => {
    const rules = {
      ...inferRules(['id', 'item']),
      categories: ['Coffee', 'Tea'],
      normalizeCategories: true,
    };
    auditCase(db, rules);
    const original = [...exportCSV(db)].join('');
    const items = listFindings(db, { filter: 'repair', limit: 30 }).map(
      (f) => ({ id: f.id, fingerprint: f.fingerprint }),
    );
    assert.throws(
      () =>
        bulkCase(db, {
          items: [items[0], { ...items[1], fingerprint: 'stale' }],
        }),
      /preview changed/,
    );
    assert.equal([...exportCSV(db)].join(''), original);
    assert.equal(caseSummary(db).applied, 0);
    bulkCase(db, { items, note: 'Reviewed every proposed value' });
    assert.equal(caseSummary(db).applied, 3);
    undoCase(db);
    assert.equal(caseSummary(db).applied, 0);
    assert.equal([...exportCSV(db)].join(''), original);
    decideCase(db, {
      ...items[0],
      action: 'keep',
      note: 'Source needs verification',
    });
    assert.ok([...exportUnresolved(db)].join('').includes('Kept unchanged'));
  });
});
void test('global priority pagination brings late high-priority issues before early repairs', async () => {
  const csv =
    'id,item,date\n' +
    Array.from(
      { length: 70 },
      (_, i) =>
        `${i + 1},${i < 60 ? ' coffee ' : 'Coffee'},${i >= 60 ? '2026-02-30' : '2026-01-01'}`,
    ).join('\n');
  await fixture(csv, (db) => {
    auditCase(db, {
      ...inferRules(['id', 'item', 'date']),
      normalizeCategories: true,
      categories: ['Coffee'],
    });
    const all = listFindings(db, { limit: 100 });
    assert.equal(all[0].rowId, 61);
    const seen: string[] = [];
    let cursor = { afterRow: 0, afterId: '', afterPriority: 1000 };
    for (let i = 0; i < 100; i++) {
      const page = listFindings(db, { ...cursor, limit: 7 }).slice(0, 7);
      if (!page.length) break;
      seen.push(...page.map((f) => f.id));
      const last = page.at(-1)!;
      cursor = {
        afterRow: last.rowId,
        afterId: last.id,
        afterPriority: last.priority,
      };
    }
    assert.deepEqual(
      seen,
      all.map((f) => f.id),
    );
    assert.equal(new Set(seen).size, seen.length);
  });
});
