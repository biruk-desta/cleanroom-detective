import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCSV,
  SAMPLE_CSV,
  SAMPLE_RULES,
  inspectCheck,
  allFindings,
  applyPatch,
  materialize,
  validateRules,
  toCSV,
  parseAnswerKey,
  scoreAnswerKey,
} from '../lib/audit.ts';
void test('sample has supported fixes plus uncertain cases, never fixes outliers', () => {
  const d = parseCSV(SAMPLE_CSV);
  const f = allFindings(d, SAMPLE_RULES);
  assert.equal(f.filter((f) => f.kind === 'repair').length, 4);
  assert.equal(f.find((f) => f.check === 'dates')?.rowId, 6);
  assert.ok(f.some((f) => f.rowId === 12 && f.kind === 'review' && !f.patch));
  let next = d;
  for (const a of f) if (a.patch) next = applyPatch(next, a.patch);
  assert.equal(next.rows.length, 11);
  assert.equal(next.rows.find((r) => r.id === 3)?.cells[2], '3');
  assert.equal(next.rows.find((r) => r.id === 8)?.cells[6], '1.2');
  assert.equal(next.rows.find((r) => r.id === 8)?.cells[7], 'kg');
  assert.equal(next.rows.find((r) => r.id === 12)?.cells[2], '20');
  assert.equal(
    allFindings(next, SAMPLE_RULES).filter((x) => x.kind === 'repair').length,
    0,
  );
});
void test('quoted multiline fields, commas, escapes and CRLF round trip', () => {
  const d = parseCSV('id,note\r\n001,"a,b\nsaid ""yes"""\r\n');
  assert.equal(d.rows[0].cells[1], 'a,b\nsaid "yes"');
  assert.deepEqual(parseCSV(toCSV(d)).rows, d.rows);
});
void test('malformed records and duplicate headers are rejected', () => {
  for (const x of [
    'id,ID\n1,2',
    'id,n\n1,2,3',
    'id,n\n1,"open',
    'id,n\n1,"x"y',
    'id,n\n',
  ])
    assert.throws(() => parseCSV(x));
});
void test('business IDs preserve case and leading zeroes; conflict is held', () => {
  const d = parseCSV('sale_id,v\n001,1\n1,1\nA,2\na,2\nA,3');
  const r = {
    ...SAMPLE_RULES,
    idColumn: 'sale_id',
    arithmetic: false,
    dateColumn: '',
    categoryColumn: '',
    valueColumn: '',
    unitColumn: '',
    convertUnits: false,
    outlierColumn: '',
    quantityColumn: '',
    priceColumn: '',
    totalColumn: '',
  };
  const f = inspectCheck(d, r, 'duplicates');
  assert.equal(f.length, 2);
  assert.deepEqual(
    f.map((x) => x.rowId),
    [3, 5],
  );
  assert.equal(f[0].kind, 'review');
  assert.equal(f[0].patch, undefined);
});
void test('division must be exact, positive and parsable', () => {
  const d = parseCSV(SAMPLE_CSV);
  const cases = [
    ['2.50', '7.50', '3'],
    ['0', '0', null],
    ['2', '5', null],
    ['2.50', '$7.50', null],
    ['0.10', '0.30', '3'],
  ];
  for (const [p, t, expected] of cases) {
    const x = {
      ...d,
      rows: [
        { id: 3, cells: ['T1', 'Tea', '', p!, t!, '2026-01-01', '1', 'kg'] },
      ],
    };
    const f = inspectCheck(x, SAMPLE_RULES, 'arithmetic')[0];
    assert.equal(f.patch?.changes[0].after ?? null, expected);
  }
});
void test('calendar dates do not silently roll over', () => {
  const d = parseCSV(SAMPLE_CSV);
  const dates = [
    '2024-02-29',
    '2025-02-29',
    '2026-04-31',
    '2026-13-01',
    '03/04/2026',
  ];
  const rows = dates.map((x, i) => ({
    id: i + 1,
    cells: ['T' + i, 'Tea', '1', '2', '2', x, '1', 'kg'],
  }));
  assert.deepEqual(
    inspectCheck({ ...d, rows }, SAMPLE_RULES, 'dates').map((x) => x.rowId),
    [2, 3, 4, 5],
  );
});
void test('categories require a unique canonical match; no fuzzy guessing', () => {
  const d = parseCSV(SAMPLE_CSV);
  const x = {
    ...d,
    rows: [
      {
        id: 1,
        cells: ['A', ' cOfFeE ', '1', '3', '3', '2026-01-01', '1', 'kg'],
      },
      { id: 2, cells: ['B', 'Coffe', '1', '3', '3', '2026-01-01', '1', 'kg'] },
    ],
  };
  const f = inspectCheck(x, SAMPLE_RULES, 'categories');
  assert.equal(f[0].patch?.changes[0].after, 'Coffee');
  assert.equal(f[1].kind, 'review');
  assert.throws(() =>
    validateRules({ ...SAMPLE_RULES, categories: ['US', 'us'] }, d.headers),
  );
});
void test('unit conversions are atomic and unknown units are held', () => {
  const d = parseCSV(SAMPLE_CSV);
  const rows = ['g', 'lb', '', 'm'].map((u, i) => ({
    id: i + 1,
    cells: ['T' + i, 'Tea', '1', '2', '2', '2026-01-01', '1250', u],
  }));
  const f = inspectCheck({ ...d, rows }, SAMPLE_RULES, 'units');
  assert.equal(f[0].patch?.changes.length, 2);
  assert.equal(f[0].patch?.changes[0].after, '1.25');
  assert.ok(f.slice(1).every((x) => !x.patch));
});
void test('stale patches fail and undo restores exact original records', () => {
  const d = parseCSV(SAMPLE_CSV);
  const f = allFindings(d, SAMPLE_RULES).find((f) => f.check === 'arithmetic')!;
  const decision = {
    id: 'x',
    finding: f,
    action: 'apply' as const,
    note: '',
    at: 'now',
  };
  const applied = materialize(d, [decision]);
  assert.throws(() => applyPatch(applied, f.patch!));
  assert.deepEqual(materialize(d, []), d);
});
void test('answer key distinguishes review from asserted defects', () => {
  const key = parseAnswerKey(
    'row,check,truth\n12,outliers,valid\n6,dates,defect',
  );
  const scored = scoreAnswerKey(
    key,
    allFindings(parseCSV(SAMPLE_CSV), SAMPLE_RULES),
  );
  assert.equal(scored[0].result, 'review requested');
  assert.equal(scored[1].result, 'caught');
  assert.throws(() =>
    parseAnswerKey('row,check,truth\n1,dates,valid\n1,dates,defect'),
  );
});
void test('empty records keep their source positions', () => {
  const d = parseCSV('id,v\n,\nA,2\n\n');
  assert.equal(d.rows.length, 2);
  assert.deepEqual(d.rows[0], { id: 1, cells: ['', ''] });
  assert.equal(d.rows[1].id, 2);
});
void test('arithmetic evidence and duplicate keeper must remain unchanged', () => {
  const d = parseCSV(SAMPLE_CSV);
  const fs = allFindings(d, SAMPLE_RULES);
  const q = fs.find((f) => f.check === 'arithmetic')!;
  const changed = {
    ...d,
    rows: d.rows.map((r) =>
      r.id === 3
        ? { ...r, cells: r.cells.map((v, i) => (i === 3 ? '3.75' : v)) }
        : r,
    ),
  };
  assert.throws(() => applyPatch(changed, q.patch!), /evidence changed/);
  const duplicate = fs.find((f) => f.check === 'duplicates')!;
  const changedKeeper = {
    ...d,
    rows: d.rows.map((r) =>
      r.id === 1
        ? { ...r, cells: r.cells.map((v, i) => (i === 1 ? 'Tea' : v)) }
        : r,
    ),
  };
  assert.throws(
    () => applyPatch(changedKeeper, duplicate.patch!),
    /evidence changed/,
  );
});
void test('numeric missing sentinels never become arithmetic evidence or outliers', () => {
  const d = parseCSV(SAMPLE_CSV);
  const rules = { ...SAMPLE_RULES, missingTokens: ['', '?', '2.50', '-999'] };
  assert.equal(inspectCheck(d, rules, 'arithmetic')[0].patch, undefined);
  const rows = [1, 1, 1, -999].map((v, i) => ({
    id: i + 1,
    cells: ['T' + i, 'Tea', String(v), '2', '2', '2026-01-01', '1', 'kg'],
  }));
  assert.equal(inspectCheck({ ...d, rows }, rules, 'outliers').length, 0);
});
