import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCSV,
  SAMPLE_CSV,
  SAMPLE_RULES,
  inspectCheck,
} from '../lib/audit.ts';
import { plannerInput, validatePlan } from '../lib/planner.ts';
void test('model input contains bounded statistics but no raw cells or names', () => {
  const d = parseCSV(SAMPLE_CSV, 'private-name.csv');
  const p = plannerInput(d, SAMPLE_RULES, []);
  const text = JSON.stringify(p);
  for (const secret of ['Coffee', 'T101', 'sale_id', 'private-name'])
    assert.equal(text.includes(secret), false);
  assert.equal(p.records, 12);
  assert.equal(p.columns[0].id, 0);
});
void test('model cannot invent checks, repeat checks, or finish prematurely', () => {
  const d = parseCSV(SAMPLE_CSV);
  const p = plannerInput(d, SAMPLE_RULES, [
    { check: 'dates', findings: inspectCheck(d, SAMPLE_RULES, 'dates') },
  ]);
  assert.throws(() => validatePlan({ next: 'dates', reason: 'Repeat' }, p));
  assert.throws(() => validatePlan({ next: 'finish', reason: 'Skip' }, p));
  assert.throws(() => validatePlan({ next: 'delete_all', reason: 'Bad' }, p));
  assert.equal(
    validatePlan({ next: 'duplicates', reason: 'Check identity' }, p).next,
    'duplicates',
  );
});
