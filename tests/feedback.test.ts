import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonCSV, convertFile } from '../lib/import-file.ts';
import {
  allFindings,
  inferRules,
  parseCSV,
  validateRules,
} from '../lib/audit.ts';
import {
  DEFAULT_OPTIONS,
  suggestOptions,
  unresolvedCSV,
  findingPriority,
} from '../lib/audit-options.ts';
import * as XLSX from 'xlsx';

void test('JSON conversion preserves late keys, large numeric IDs, booleans and nulls', () => {
  const csv = jsonCSV(
    '[{"id":9007199254740993123,"name":"héllo","active":true},{"id":"002","other":null}]',
  );
  const data = parseCSV(csv);
  assert.deepEqual(data.headers, ['id', 'name', 'active', 'other']);
  assert.equal(data.rows[0].cells[0], '9007199254740993123');
  assert.equal(data.rows[1].cells[0], '002');
  assert.equal(data.rows[0].cells[2], 'true');
  assert.equal(data.rows[1].cells[3], '');
  assert.throws(() => jsonCSV('[{"id":1,"nested":{"x":2}}]'), /Nested/);
  assert.throws(() => jsonCSV('{"id":1}'), /array/);
});
void test('Excel import offers every worksheet, preserves formatted IDs and original bytes', async () => {
  const workbook = XLSX.utils.book_new();
  const first = XLSX.utils.aoa_to_sheet([
    ['id', 'value'],
    [1, 4],
  ]);
  first.A2.z = '0000';
  XLSX.utils.book_append_sheet(workbook, first, 'Employees');
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['id', 'value'],
      ['02', 'x'],
    ]),
    'Other',
  );
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const file = new File([bytes], 'test.xlsx');
  const converted = await convertFile(file);
  assert.deepEqual(
    converted.sheets.map((s) => s.name),
    ['Employees', 'Other'],
  );
  assert.equal(parseCSV(converted.sheets[0].csv).rows[0].cells[0], '0001');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
  assert.ok(converted.warnings.join(' ').includes('Formulas are not executed'));
});
void test('goal suggestions remain unconfirmed and custom rules prioritize source verification', () => {
  const data = parseCSV(
    'employee_id,name,email,age\n01,,bad,-1\n02,Alex,a@example.com,30',
  );
  const inferred = suggestOptions(
    data.headers,
    inferRules(data.headers),
    'Check employee emails',
    'custom',
  );
  assert.equal(inferred.audit?.domain, 'employees');
  assert.equal(inferred.audit?.emailColumn, 'email');
  assert.equal(inferred.uniqueIds, false);
  assert.equal(inferred.arithmetic, false);
  const rules = {
    ...inferred,
    audit: {
      ...DEFAULT_OPTIONS,
      ...inferred.audit,
      required: ['name'],
      rangeColumn: 'age',
      minimum: 0,
      maximum: 120,
    },
  };
  const findings = allFindings(data, rules);
  assert.deepEqual(findings.map((f) => f.check).sort(), [
    'email',
    'range',
    'required',
  ]);
  assert.ok(findings.every((f) => !f.patch));
  assert.ok(findings.every((f) => findingPriority(f) >= 30));
  assert.throws(
    () =>
      validateRules(
        { ...rules, audit: { ...rules.audit, minimum: 130 } },
        data.headers,
      ),
    /minimum/,
  );
  const unresolved = unresolvedCSV(findings, [
    { finding: findings[0], action: 'keep', note: 'source unclear' },
  ]);
  assert.ok(unresolved.includes('Kept unchanged'));
  assert.ok(unresolved.includes('source unclear'));
});
