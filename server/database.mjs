import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { readCSV } from './csv.mjs';
import {
  availableChecks,
  inspectCheck,
  inferRules,
  validateRules,
  numberValue,
  isMissing,
  applyPatch,
  csvCell,
} from '../lib/audit.ts';

const BATCH = 2000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function openCase(path, readOnly = false) {
  const db = new DatabaseSync(path, { readOnly, timeout: 5000 });
  db.exec(
    'PRAGMA cache_size=-32768; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA busy_timeout=5000;',
  );
  if (!readOnly)
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, original TEXT NOT NULL, updated TEXT, deleted INTEGER NOT NULL DEFAULT 0, idkey TEXT, numeric REAL);
    CREATE INDEX IF NOT EXISTS row_identity ON rows(idkey,deleted,id);
    CREATE INDEX IF NOT EXISTS row_numeric ON rows(deleted,numeric,id);
    CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, row_id INTEGER NOT NULL, check_name TEXT NOT NULL, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS findings_rows ON findings(row_id,id);
    CREATE INDEX IF NOT EXISTS findings_checks ON findings(check_name,row_id);
    CREATE TABLE IF NOT EXISTS decisions (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, finding_id TEXT NOT NULL, fingerprint TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL, prior TEXT, prior_deleted INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS decisions_finding ON decisions(finding_id,fingerprint);
  `);
  return db;
}
export const getMeta = (db, key) => {
  const value = db
    .prepare('SELECT value FROM meta WHERE key=?')
    .get(key)?.value;
  return value ? JSON.parse(value) : null;
};
export const setMeta = (db, key, value) =>
  db
    .prepare('INSERT OR REPLACE INTO meta VALUES (?,?)')
    .run(key, JSON.stringify(value));
const rowObject = (raw) => ({
  id: raw.id,
  cells: JSON.parse(raw.updated ?? raw.original),
});
const readRow = (db, id) => {
  const raw = db.prepare('SELECT * FROM rows WHERE id=? AND deleted=0').get(id);
  return raw ? rowObject(raw) : null;
};
const dataset = (headers, rows) => ({ name: '', headers, rows, original: '' });
const clipped = (value) =>
  value === ''
    ? '(empty)'
    : value.length > 160
      ? value.slice(0, 160) + '…'
      : value;
function insertFinding(db, finding) {
  const payload = JSON.stringify(finding);
  db.prepare('INSERT OR REPLACE INTO findings VALUES (?,?,?,?,?,?)').run(
    finding.id,
    finding.rowId,
    finding.check,
    finding.kind,
    hash(payload),
    payload,
  );
}
function indexed(cells, headers, rules) {
  const identity = rules.idColumn
    ? cells[headers.indexOf(rules.idColumn)]
    : null;
  const raw = rules.outlierColumn
    ? cells[headers.indexOf(rules.outlierColumn)]
    : null;
  return [
    identity !== null && !isMissing(identity, rules) ? identity : null,
    raw !== null && !isMissing(raw, rules) ? numberValue(raw) : null,
  ];
}
function transact(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
export async function importCase(db, source, name, notify = () => {}) {
  db.exec(
    'DELETE FROM rows; DELETE FROM findings; DELETE FROM decisions; DELETE FROM meta;',
  );
  let headers = null,
    count = 0,
    bytes = 0;
  const insert = db.prepare('INSERT INTO rows(id,original) VALUES (?,?)');
  db.exec('BEGIN');
  try {
    for await (const cells of readCSV(source, {
      progress: (n) => {
        bytes = n;
      },
    })) {
      if (!headers) {
        headers = cells.map((v) => v.trim());
        if (
          headers.length < 2 ||
          headers.some((v) => !v) ||
          new Set(headers.map((v) => v.toLowerCase())).size !== headers.length
        )
          throw new Error(
            'Use at least two columns with nonempty, unique names.',
          );
        setMeta(db, 'headers', headers);
        setMeta(db, 'name', name);
        continue;
      }
      count++;
      if (count > 20_000_000)
        throw new Error(
          'This service supports up to 20 million rows per file.',
        );
      if (cells.length !== headers.length)
        throw new Error(
          `Record ${count} has ${cells.length} fields; expected ${headers.length}.`,
        );
      insert.run(count, JSON.stringify(cells));
      if (count % BATCH === 0) {
        db.exec('COMMIT');
        notify({ phase: 'Reading your file', records: count, bytes });
        db.exec('BEGIN');
      }
    }
    if (!headers || !count)
      throw new Error('Include a header and at least one data record.');
    setMeta(db, 'records', count);
    setMeta(db, 'rules', inferRules(headers));
    setMeta(db, 'checked', false);
    db.exec('COMMIT');
    notify({ phase: 'Your file is ready', records: count, bytes });
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
  return { headers, records: count, rules: getMeta(db, 'rules') };
}
function localFindings(db, headers, rules, rows) {
  for (const check of availableChecks(rules).filter(
    (c) => !['duplicates', 'outliers'].includes(c),
  )) {
    for (const finding of inspectCheck(dataset(headers, rows), rules, check))
      insertFinding(db, finding);
  }
  if (rules.idColumn) {
    const missing = rows.filter((row) =>
      isMissing(row.cells[headers.indexOf(rules.idColumn)], rules),
    );
    for (const finding of inspectCheck(
      dataset(headers, missing),
      rules,
      'duplicates',
    ))
      insertFinding(db, finding);
  }
}
function duplicateGroup(db, headers, rules, key) {
  const group = db
    .prepare(
      'SELECT COUNT(*) AS n, MIN(id) AS first, MIN(COALESCE(updated,original)) AS low, MAX(COALESCE(updated,original)) AS high FROM rows WHERE idkey=? AND deleted=0',
    )
    .get(key);
  if (group.n < 2) return;
  const same = group.low === group.high;
  const keeper = readRow(db, group.first);
  const related = db
    .prepare(
      'SELECT id FROM rows WHERE idkey=? AND deleted=0 ORDER BY id LIMIT 20',
    )
    .all(key)
    .map((x) => x.id);
  const query = db.prepare(
    'SELECT * FROM rows WHERE idkey=? AND deleted=0 ORDER BY id',
  );
  for (const raw of query.iterate(key)) {
    const row = rowObject(raw);
    if (same && row.id === keeper.id) continue;
    const finding = {
      id: `duplicates:${row.id}:${rules.idColumn}`,
      check: 'duplicates',
      rowId: row.id,
      column: rules.idColumn,
    };
    if (same && rules.uniqueIds) {
      Object.assign(finding, {
        title: 'Exact duplicate record',
        detail: `Keep record ${keeper.id}; remove the extra copy from the working dataset.`,
        kind: 'repair',
        evidence: [
          `Sale ID ${clipped(key)} appears ${group.n} times.`,
          `Every field matches record ${keeper.id}.`,
          'Confirmed rule: one record per unique ID.',
        ],
        patch: {
          rowId: row.id,
          changes: [],
          deleteRow: true,
          snapshot: row.cells,
          dependencies: [keeper],
        },
      });
    } else
      Object.assign(finding, {
        title: same
          ? 'Repeated ID needs a rule'
          : 'Conflicting records share an ID',
        detail: same
          ? 'Confirm that each ID must identify one record before deleting anything.'
          : 'The records disagree. A human must decide which source is correct.',
        evidence: [
          `ID: ${clipped(key)}`,
          `Related records: ${related.join(', ')}${group.n > related.length ? ` … (${group.n} total; open related rows for more)` : ''}`,
          same
            ? 'Fields match; uniqueness is not confirmed.'
            : 'Different values exist under the same ID.',
        ],
        kind: 'review',
      });
    insertFinding(db, finding);
  }
}
function outliers(db, rules) {
  db.prepare("DELETE FROM findings WHERE check_name='outliers'").run();
  setMeta(db, 'outlierRange', null);
  if (!rules.checkOutliers || !rules.outlierColumn) return;
  const n = db
    .prepare(
      'SELECT COUNT(*) AS n FROM rows WHERE deleted=0 AND numeric IS NOT NULL',
    )
    .get().n;
  if (n < 4) return;
  const valueAt = db.prepare(
    'SELECT numeric FROM rows WHERE deleted=0 AND numeric IS NOT NULL ORDER BY numeric,id LIMIT 1 OFFSET ?',
  );
  const quantile = (p) => {
    const position = (n - 1) * p,
      low = Math.floor(position);
    const a = valueAt.get(low).numeric,
      b = valueAt.get(Math.min(low + 1, n - 1)).numeric;
    return a + (b - a) * (position - low);
  };
  const q1 = quantile(0.25),
    q3 = quantile(0.75),
    iqr = q3 - q1,
    low = q1 - 1.5 * iqr,
    high = q3 + 1.5 * iqr;
  setMeta(db, 'outlierRange', { count: n, q1, q3, low, high });
  // NULL/Infinity bounds cannot be SQL numbers; finite numeric cells still follow JS comparisons.
  const bounds = [
    Number.isFinite(low) ? low : -Number.MAX_VALUE,
    Number.isFinite(high) ? high : Number.MAX_VALUE,
  ];
  for (const raw of db
    .prepare(
      'SELECT id,numeric FROM rows WHERE deleted=0 AND (numeric<? OR numeric>?) ORDER BY id',
    )
    .iterate(...bounds)) {
    if (!(raw.numeric < low || raw.numeric > high)) continue;
    insertFinding(db, {
      id: `outliers:${raw.id}:${rules.outlierColumn}`,
      check: 'outliers',
      rowId: raw.id,
      column: rules.outlierColumn,
      title: 'Unusual value · not proven wrong',
      detail: 'Keep the value unless source evidence supports a correction.',
      kind: 'review',
      evidence: [
        `Observed: ${raw.numeric}; reference cohort: ${n} numeric records.`,
        `Q1 ${q1.toFixed(2)}, Q3 ${q3.toFixed(2)}; 1.5 × IQR interval: ${low.toFixed(2)} to ${high.toFixed(2)}.`,
        'A statistical outlier may be a legitimate large order.',
      ],
    });
  }
}
export function auditCase(db, rules, notify = () => {}) {
  const headers = getMeta(db, 'headers');
  validateRules(rules, headers);
  if (!availableChecks(rules).length)
    throw new Error('Choose at least one check.');
  const priorRules = getMeta(db, 'rules');
  if (
    db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n &&
    JSON.stringify(priorRules) !== JSON.stringify(rules)
  )
    throw new Error(
      'Undo your decisions before changing the checks for this file.',
    );
  setMeta(db, 'checked', false);
  setMeta(db, 'rules', rules);
  db.exec('DELETE FROM findings;');
  const update = db.prepare('UPDATE rows SET idkey=?,numeric=? WHERE id=?');
  let cursor = 0;
  while (true) {
    const batch = [];
    let batchBytes = 0;
    for (const raw of db
      .prepare(
        'SELECT * FROM rows WHERE id>? AND deleted=0 ORDER BY id LIMIT ?',
      )
      .iterate(cursor, BATCH)) {
      batch.push(raw);
      batchBytes += (raw.original.length + (raw.updated?.length ?? 0)) * 2;
      if (batchBytes >= 8 * 1024 * 1024) break;
    }
    if (!batch.length) break;
    transact(db, () => {
      const rows = batch.map(rowObject);
      for (const row of rows)
        update.run(...indexed(row.cells, headers, rules), row.id);
      localFindings(db, headers, rules, rows);
    });
    cursor = batch.at(-1).id;
    notify({ phase: 'Checking rows', records: cursor });
  }
  if (rules.idColumn) {
    notify({ phase: 'Comparing repeated IDs', records: cursor });
    // Read groups from an independent cursor, never accumulate all IDs in memory.
    for (const { idkey } of db
      .prepare(
        'SELECT idkey FROM rows WHERE idkey IS NOT NULL AND deleted=0 GROUP BY idkey HAVING COUNT(*)>1',
      )
      .iterate()) {
      transact(db, () => duplicateGroup(db, headers, rules, idkey));
    }
  }
  notify({ phase: 'Checking unusual values', records: cursor });
  transact(db, () => outliers(db, rules));
  setMeta(db, 'checked', true);
  db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  return caseSummary(db);
}
function recheckRow(db, id, beforeKey, beforeNumber, wasDeleted, notify) {
  const headers = getMeta(db, 'headers'),
    rules = getMeta(db, 'rules');
  db.prepare(
    "DELETE FROM findings WHERE row_id=? AND check_name NOT IN ('duplicates','outliers')",
  ).run(id);
  const row = readRow(db, id);
  let key = null,
    numeric = null;
  if (row) {
    [key, numeric] = indexed(row.cells, headers, rules);
    db.prepare('UPDATE rows SET idkey=?,numeric=? WHERE id=?').run(
      key,
      numeric,
      id,
    );
    localFindings(db, headers, rules, [row]);
  }
  db.prepare(
    "DELETE FROM findings WHERE row_id=? AND check_name='duplicates'",
  ).run(id);
  for (const groupKey of new Set([beforeKey, key].filter((x) => x !== null))) {
    db.prepare(
      "DELETE FROM findings WHERE check_name='duplicates' AND row_id IN (SELECT id FROM rows WHERE idkey=?)",
    ).run(groupKey);
    duplicateGroup(db, headers, rules, groupKey);
  }
  if (row && rules.idColumn && key === null)
    localFindings(db, headers, rules, [row]);
  if (beforeNumber !== numeric || wasDeleted !== !row) {
    notify({ phase: 'Updating the comparison across your file' });
    outliers(db, rules);
  }
}
export function decideCase(db, request, notify = () => {}) {
  if (!getMeta(db, 'checked'))
    throw new Error('Finish checking the file before reviewing a suggestion.');
  if (
    !['apply', 'keep'].includes(request.action) ||
    typeof request.id !== 'string' ||
    typeof request.fingerprint !== 'string'
  )
    throw new Error('Choose an existing suggestion and an action.');
  const note = typeof request.note === 'string' ? request.note.trim() : '';
  if (note.length > 2000) throw new Error('Keep notes under 2,000 characters.');
  return transact(db, () => {
    const record = db
      .prepare('SELECT * FROM findings WHERE id=?')
      .get(request.id);
    if (!record || record.fingerprint !== request.fingerprint)
      throw new Error('This suggestion changed. Refresh it before deciding.');
    if (
      db
        .prepare('SELECT 1 FROM decisions WHERE finding_id=? AND fingerprint=?')
        .get(request.id, request.fingerprint)
    )
      throw new Error('This suggestion has already been reviewed.');
    const finding = JSON.parse(record.payload),
      headers = getMeta(db, 'headers');
    const raw = db
      .prepare('SELECT * FROM rows WHERE id=? AND deleted=0')
      .get(finding.rowId);
    if (!raw) throw new Error('The row no longer exists. Refresh your review.');
    const row = rowObject(raw);
    const manual = request.manual !== undefined;
    if (manual) {
      if (
        request.action !== 'apply' ||
        finding.patch ||
        !note ||
        typeof request.manual !== 'string' ||
        !request.manual.trim() ||
        request.manual.length > 4000
      )
        throw new Error(
          'Enter a source-verified value and a note identifying its source.',
        );
      const col = headers.indexOf(finding.column);
      if (col < 0)
        throw new Error('This suggestion cannot be corrected as one cell.');
      finding.patch = {
        rowId: row.id,
        changes: [
          { column: col, before: row.cells[col], after: request.manual },
        ],
      };
    }
    if (request.action === 'apply') {
      if (!finding.patch)
        throw new Error(
          'This item needs a verified correction or a keep decision.',
        );
      const dependencies = (finding.patch.dependencies ?? [])
        .map((d) => readRow(db, d.id))
        .filter(Boolean);
      const unique = [
        ...new Map([row, ...dependencies].map((r) => [r.id, r])).values(),
      ];
      const updated = applyPatch(
        dataset(headers, unique),
        finding.patch,
      ).rows.find((r) => r.id === row.id);
      db.prepare('UPDATE rows SET updated=?,deleted=? WHERE id=?').run(
        updated ? JSON.stringify(updated.cells) : raw.updated,
        updated ? 0 : 1,
        row.id,
      );
      recheckRow(db, row.id, raw.idkey, raw.numeric, false, notify);
      if (
        manual &&
        db.prepare('SELECT 1 FROM findings WHERE id=?').get(finding.id)
      )
        throw new Error(
          'That value is still flagged by this check. Verify it against your source.',
        );
    }
    const actionNote =
      note ||
      (request.action === 'keep'
        ? 'Kept unchanged by the reviewer; no correction was verified.'
        : '');
    db.prepare(
      'INSERT INTO decisions(id,finding_id,fingerprint,action,note,at,payload,prior,prior_deleted) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      randomUUID(),
      finding.id,
      record.fingerprint,
      request.action,
      actionNote,
      new Date().toISOString(),
      JSON.stringify(finding),
      raw.updated,
      raw.deleted,
    );
    return caseSummary(db);
  });
}
export function undoCase(db, notify = () => {}) {
  return transact(db, () => {
    const d = db
      .prepare('SELECT * FROM decisions ORDER BY seq DESC LIMIT 1')
      .get();
    if (!d) throw new Error('There is no decision to undo.');
    const finding = JSON.parse(d.payload);
    if (d.action === 'apply') {
      const raw = db
        .prepare('SELECT * FROM rows WHERE id=?')
        .get(finding.rowId);
      db.prepare('UPDATE rows SET updated=?,deleted=? WHERE id=?').run(
        d.prior,
        d.prior_deleted,
        finding.rowId,
      );
      recheckRow(
        db,
        finding.rowId,
        raw.idkey,
        raw.numeric,
        !!raw.deleted,
        notify,
      );
    }
    db.prepare('DELETE FROM decisions WHERE seq=?').run(d.seq);
    return caseSummary(db);
  });
}
const pendingWhere =
  'NOT EXISTS (SELECT 1 FROM decisions d WHERE d.finding_id=f.id AND d.fingerprint=f.fingerprint)';
export function caseSummary(db) {
  const n = (query) => db.prepare(query).get().n;
  return {
    headers: getMeta(db, 'headers') ?? [],
    rules: getMeta(db, 'rules'),
    checked: !!getMeta(db, 'checked'),
    name: getMeta(db, 'name'),
    sourceRecords: getMeta(db, 'records') ?? 0,
    records: n('SELECT COUNT(*) AS n FROM rows WHERE deleted=0'),
    pending: n(`SELECT COUNT(*) AS n FROM findings f WHERE ${pendingWhere}`),
    repairs: n(
      `SELECT COUNT(*) AS n FROM findings f WHERE kind='repair' AND ${pendingWhere}`,
    ),
    decisions: n('SELECT COUNT(*) AS n FROM decisions'),
    applied: n("SELECT COUNT(*) AS n FROM decisions WHERE action='apply'"),
    kept: n("SELECT COUNT(*) AS n FROM decisions WHERE action='keep'"),
  };
}
/** @returns {import('../lib/large-types.ts').LargeFinding[]} */
export function listFindings(
  db,
  {
    afterRow = 0,
    afterId = '',
    limit = 30,
    filter = 'pending',
    check = '',
  } = {},
) {
  const clauses = ['(f.row_id>? OR (f.row_id=? AND f.id>?))'],
    params = [afterRow, afterRow, afterId];
  if (filter === 'pending') clauses.push(pendingWhere);
  else if (filter === 'repair') clauses.push("f.kind='repair'", pendingWhere);
  else if (filter === 'review') clauses.push("f.kind<>'repair'", pendingWhere);
  if (check) {
    clauses.push('f.check_name=?');
    params.push(check);
  }
  const items = db
    .prepare(
      `SELECT f.* FROM findings f WHERE ${clauses.join(' AND ')} ORDER BY row_id,id LIMIT ?`,
    )
    .all(...params, limit + 1);
  return items.map((f) => ({
    ...JSON.parse(f.payload),
    fingerprint: f.fingerprint,
    reviewed: !!db
      .prepare('SELECT 1 FROM decisions WHERE finding_id=? AND fingerprint=?')
      .get(f.id, f.fingerprint),
  }));
}
/** @returns {(import('../lib/audit.ts').Row & {changed: boolean})[]} */
export function listRows(db, { after = 0, limit = 50, related = null } = {}) {
  const where = related === null ? '' : ' AND idkey=?';
  const params = related === null ? [after, limit] : [after, related, limit];
  return db
    .prepare(
      `SELECT * FROM rows WHERE id>? AND deleted=0${where} ORDER BY id LIMIT ?`,
    )
    .all(...params)
    .map((raw) => ({ ...rowObject(raw), changed: raw.updated !== null }));
}
export function* exportCSV(db) {
  yield getMeta(db, 'headers').map(csvCell).join(',') + '\r\n';
  for (const raw of db
    .prepare('SELECT original,updated FROM rows WHERE deleted=0 ORDER BY id')
    .iterate())
    yield (
      JSON.parse(raw.updated ?? raw.original)
        .map(csvCell)
        .join(',') + '\r\n'
    );
}
export function* exportDecisions(db) {
  const headers = getMeta(db, 'headers');
  yield (
    [
      'time',
      'source_record',
      'check',
      'action',
      'column',
      'before',
      'after',
      'evidence',
      'reviewer_note',
    ].join(',') + '\r\n'
  );
  for (const d of db
    .prepare('SELECT * FROM decisions ORDER BY seq')
    .iterate()) {
    const f = JSON.parse(d.payload),
      changes =
        d.action === 'apply' && f.patch?.changes?.length
          ? f.patch.changes
          : [null];
    for (const c of changes)
      yield (
        [
          d.at,
          String(f.rowId),
          f.check,
          d.action,
          c ? headers[c.column] : f.column,
          c?.before ??
            (d.action === 'apply' && f.patch?.deleteRow
              ? JSON.stringify(f.patch.snapshot)
              : ''),
          c?.after ?? '',
          f.evidence.join(' | '),
          d.note,
        ]
          .map(csvCell)
          .join(',') + '\r\n'
      );
  }
}
