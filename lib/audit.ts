import {
  type AuditOptions,
  optionsFor,
  validateOptions,
  outlierMultiplier,
  customFindings,
  findingMeta,
  findingPriority,
} from './audit-options.ts';
export type Row = { id: number; cells: string[] };
export type Dataset = {
  name: string;
  headers: string[];
  rows: Row[];
  original: string;
};
export type Check =
  | 'duplicates'
  | 'arithmetic'
  | 'dates'
  | 'categories'
  | 'units'
  | 'outliers'
  | 'required'
  | 'email'
  | 'range';
export const CHECKS: Check[] = [
  'duplicates',
  'arithmetic',
  'dates',
  'categories',
  'units',
  'outliers',
  'required',
  'email',
  'range',
];
export const CHECK_NAMES: Record<Check, string> = {
  duplicates: 'Duplicate records',
  arithmetic: 'Missing quantities',
  dates: 'Calendar dates',
  categories: 'Category consistency',
  units: 'Explicit units',
  outliers: 'Unusual values',
  required: 'Required values',
  email: 'Email structure',
  range: 'Numeric limits',
};
export type Rules = {
  audit?: AuditOptions;
  idColumn: string;
  uniqueIds: boolean;
  quantityColumn: string;
  priceColumn: string;
  totalColumn: string;
  arithmetic: boolean;
  dateColumn: string;
  categoryColumn: string;
  categories: string[];
  normalizeCategories: boolean;
  valueColumn: string;
  unitColumn: string;
  targetUnit: 'kg' | 'g';
  convertUnits: boolean;
  outlierColumn: string;
  checkOutliers: boolean;
  missingTokens: string[];
};
export type CellChange = { column: number; before: string; after: string };
export type Patch = {
  rowId: number;
  changes: CellChange[];
  deleteRow?: boolean;
  snapshot?: string[];
  dependencies?: Row[];
};
export type Finding = {
  id: string;
  check: Check;
  rowId: number;
  column: string;
  title: string;
  detail: string;
  evidence: string[];
  kind: 'repair' | 'issue' | 'review';
  severity?: 'low' | 'medium' | 'high' | 'critical';
  confidence?: string;
  priority?: number;
  patch?: Patch;
};
export type Decision = {
  batchId?: string;
  id: string;
  finding: Finding;
  action: 'apply' | 'keep';
  note: string;
  at: string;
};
export type Trace = {
  step: number;
  tool: string;
  summary: string;
  findings: number;
  at: string;
};
export type KeyEntry = { row: number; check: Check; truth: 'defect' | 'valid' };

export const SAMPLE_CSV = `sale_id,item,quantity,unit_price,total,date,weight,unit
T101,Coffee,2,3.00,6.00,2026-09-18,0.50,kg
T101,Coffee,2,3.00,6.00,2026-09-18,0.50,kg
T102,Tea,?,2.50,7.50,2026-09-18,0.25,kg
T103," coffee ",1,3.00,3.00,2026-09-18,0.25,kg
T104,Sandwich,2,8.00,16.00,2026-09-18,0.80,kg
T105,Tea,2,2.50,5.00,2026-02-30,0.30,kg
T106,Coffee,3,3.00,9.00,2026-09-18,0.75,kg
T107,Sandwich,3,8.00,24.00,2026-09-18,1200,g
T108,Tea,1,2.50,2.50,2026-09-18,0.15,kg
T109,Coffee,2,3.00,6.00,2026-09-18,0.50,kg
T110,Sandwich,1,8.00,8.00,2026-09-18,0.40,kg
T111,Coffee,20,3.00,60.00,2026-09-18,5.00,kg`;

export const SAMPLE_RULES: Rules = {
  idColumn: 'sale_id',
  uniqueIds: true,
  quantityColumn: 'quantity',
  priceColumn: 'unit_price',
  totalColumn: 'total',
  arithmetic: true,
  dateColumn: 'date',
  categoryColumn: 'item',
  categories: ['Coffee', 'Tea', 'Sandwich'],
  normalizeCategories: true,
  valueColumn: 'weight',
  unitColumn: 'unit',
  targetUnit: 'kg',
  convertUnits: true,
  outlierColumn: 'quantity',
  checkOutliers: true,
  missingTokens: ['', '?', 'NULL', 'N/A'],
};

export function parseCSV(text: string, name = 'dataset.csv'): Dataset {
  if (new TextEncoder().encode(text).length > 1_000_000)
    throw new Error('Use a CSV smaller than 1 MB for this prototype.');
  const input = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let record: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    explicit = false;
  const finishField = () => {
    record.push(field);
    field = '';
    closed = false;
  };
  const finishRow = () => {
    finishField();
    if (explicit || record.some((v) => v !== '')) records.push(record);
    record = [];
    explicit = false;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
      continue;
    }
    if (closed && c !== ',' && c !== '\r' && c !== '\n')
      throw new Error('Unexpected text after a quoted CSV field.');
    if (c === '"') {
      if (field !== '')
        throw new Error('A quote appears inside an unquoted field.');
      quoted = true;
      explicit = true;
    } else if (c === ',') {
      explicit = true;
      finishField();
    } else if (c === '\n' || c === '\r') {
      finishRow();
      if (c === '\r' && input[i + 1] === '\n') i++;
    } else field += c;
    if (field.length > 4000)
      throw new Error('A CSV cell exceeds the 4,000-character limit.');
    if (records.length > 5001) throw new Error('Use at most 5,000 records.');
  }
  if (quoted) throw new Error('A quoted CSV field was not closed.');
  if (field !== '' || record.length || closed) finishRow();
  if (records.length < 2)
    throw new Error('Include a header and at least one data record.');
  const headers = records.shift()!.map((x) => x.trim());
  if (headers.length < 2 || headers.length > 40)
    throw new Error('Use a comma-separated file with 2–40 columns.');
  if (
    headers.some((x) => !x) ||
    new Set(headers.map((x) => x.toLowerCase())).size !== headers.length
  )
    throw new Error('Column names must be nonempty and unique, ignoring case.');
  const rows = records.map((cells, i) => {
    if (cells.length !== headers.length)
      throw new Error(
        `Record ${i + 1} has ${cells.length} fields; expected ${headers.length}.`,
      );
    if (cells.some((c) => c.length > 4000))
      throw new Error(`Record ${i + 1} has an oversized cell.`);
    return { id: i + 1, cells };
  });
  if (rows.length > 5000) throw new Error('Use at most 5,000 records.');
  return { name: name.slice(0, 120), headers, rows, original: text };
}

export function inferRules(headers: string[]): Rules {
  const find = (names: string[]) =>
    headers.find((h) =>
      names.includes(h.toLowerCase().replace(/[ -]/g, '_')),
    ) ?? '';
  return {
    idColumn: find(['id', 'sale_id', 'transaction_id']),
    uniqueIds: false,
    quantityColumn: find(['qty', 'quantity']),
    priceColumn: find(['price', 'unit_price']),
    totalColumn: find(['total', 'line_total', 'amount']),
    arithmetic: false,
    dateColumn: find(['date', 'sale_date', 'transaction_date']),
    categoryColumn: find(['item', 'category', 'product']),
    categories: [],
    normalizeCategories: false,
    valueColumn: find(['weight', 'mass', 'weight_kg']),
    unitColumn: find(['unit', 'weight_unit']),
    targetUnit: 'kg',
    convertUnits: false,
    outlierColumn: find(['quantity', 'qty', 'amount']),
    checkOutliers: true,
    missingTokens: [''],
  };
}
export function validateRules(raw: unknown, headers: string[]): Rules {
  if (!raw || typeof raw !== 'object')
    throw new Error('Data rules are missing.');
  const r = raw as Rules;
  for (const k of [
    'idColumn',
    'quantityColumn',
    'priceColumn',
    'totalColumn',
    'dateColumn',
    'categoryColumn',
    'valueColumn',
    'unitColumn',
    'outlierColumn',
  ] as const) {
    if (typeof r[k] !== 'string' || (r[k] && !headers.includes(r[k])))
      throw new Error(`Invalid column mapping: ${k}.`);
  }
  for (const k of [
    'uniqueIds',
    'arithmetic',
    'normalizeCategories',
    'convertUnits',
    'checkOutliers',
  ] as const)
    if (typeof r[k] !== 'boolean') throw new Error('Invalid rule setting.');
  if (
    !Array.isArray(r.missingTokens) ||
    r.missingTokens.length > 20 ||
    r.missingTokens.some((x) => typeof x !== 'string' || x.length > 60)
  )
    throw new Error('Invalid missing-value tokens.');
  if (
    !Array.isArray(r.categories) ||
    r.categories.length > 100 ||
    r.categories.some(
      (x) => typeof x !== 'string' || !x.trim() || x.length > 100,
    )
  )
    throw new Error('Invalid category vocabulary.');
  if (
    new Set(r.categories.map((x) => x.trim().toLowerCase())).size !==
    r.categories.length
  )
    throw new Error(
      'Canonical category labels overlap after trimming and ignoring case.',
    );
  if (!['kg', 'g'].includes(r.targetUnit))
    throw new Error('Choose kg or g as the target unit.');
  if (r.arithmetic) {
    const cols = [r.quantityColumn, r.priceColumn, r.totalColumn];
    if (cols.some((x) => !x) || new Set(cols).size !== 3)
      throw new Error('Map three distinct columns for the quantity rule.');
  }
  if (
    r.convertUnits &&
    (!r.valueColumn || !r.unitColumn || r.valueColumn === r.unitColumn)
  )
    throw new Error('Map distinct value and unit columns.');
  validateOptions(r, headers);
  return r;
}
export function isMissing(value: string, r: Rules) {
  return r.missingTokens.includes(value.trim());
}
export function numberValue(s: string): number | null {
  return /^-?\d+(?:\.\d+)?$/.test(s.trim()) && Number.isFinite(Number(s))
    ? Number(s)
    : null;
}
type Decimal = { n: bigint; scale: number };
function decimal(s: string): Decimal | null {
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(s.trim()) || s.trim().length > 20)
    return null;
  const [a, b = ''] = s.trim().split('.');
  return { n: BigInt(a + b), scale: b.length };
}
function exactQuantity(total: string, price: string): string | null {
  const t = decimal(total),
    p = decimal(price);
  if (!t || !p || p.n <= 0n) return null;
  const numerator = t.n * 10n ** BigInt(p.scale),
    denominator = p.n * 10n ** BigInt(t.scale);
  if (numerator <= 0n || numerator % denominator !== 0n) return null;
  const q = numerator / denominator;
  return q <= 1_000_000_000n ? q.toString() : null;
}
function formatDecimal(n: bigint, scale: number) {
  const sign = n < 0n ? '-' : '';
  let digits = (n < 0n ? -n : n).toString().padStart(scale + 1, '0');
  if (scale) digits = digits.slice(0, -scale) + '.' + digits.slice(-scale);
  return sign + (scale ? digits.replace(/0+$/, '').replace(/\.$/, '') : digits);
}
function convertMass(
  raw: string,
  source: string,
  target: string,
): string | null {
  const d = decimal(raw);
  if (!d || d.n < 0n) return null;
  if (source === target) return raw;
  if (source === 'g' && target === 'kg') return formatDecimal(d.n, d.scale + 3);
  if (source === 'kg' && target === 'g')
    return formatDecimal(d.n * 1000n, d.scale);
  return null;
}
function validDate(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1],
    month = +m[2],
    day = +m[3];
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    y >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
  );
}
function quantile(values: number[], p: number) {
  const n = (values.length - 1) * p,
    lo = Math.floor(n);
  return (
    values[lo] +
    (values[Math.min(lo + 1, values.length - 1)] - values[lo]) * (n - lo)
  );
}
const show = (s: string) =>
  s === '' ? '(empty)' : s.length > 160 ? s.slice(0, 160) + '…' : s;
export function profile(data: Dataset, rules: Rules) {
  return {
    records: data.rows.length,
    columns: data.headers.map((name, col) => {
      const raw = data.rows.map((r) => r.cells[col]);
      const nums = raw
        .filter((x) => !isMissing(x, rules))
        .map(numberValue)
        .filter((x): x is number => x !== null);
      return {
        name,
        missing: raw.filter((x) => isMissing(x, rules)).length,
        distinct: new Set(raw).size,
        numeric: nums.length,
        min: nums.length ? Math.min(...nums) : null,
        max: nums.length ? Math.max(...nums) : null,
      };
    }),
    availableChecks: availableChecks(rules),
  };
}
export function availableChecks(r: Rules): Check[] {
  return CHECKS.filter(
    (k) =>
      ({
        duplicates: !!r.idColumn,
        arithmetic: r.arithmetic && !!r.quantityColumn,
        dates: !!r.dateColumn,
        categories:
          r.normalizeCategories &&
          !!r.categoryColumn &&
          r.categories.length > 0,
        units: r.convertUnits && !!r.valueColumn && !!r.unitColumn,
        outliers: r.checkOutliers && !!r.outlierColumn,
        required: optionsFor(r).required.length > 0,
        email: !!optionsFor(r).emailColumn,
        range: !!optionsFor(r).rangeColumn,
      })[k],
  );
}

export function inspectCheck(data: Dataset, r: Rules, check: Check): Finding[] {
  validateRules(r, data.headers);
  if (!CHECKS.includes(check)) throw new Error('Unknown investigation check.');
  if (!availableChecks(r).includes(check)) return [];
  if (check === 'required' || check === 'email' || check === 'range')
    return customFindings(data, r, check).map((f) => ({
      ...f,
      ...findingMeta(f),
      priority: findingPriority(f),
    }));
  const out: Finding[] = [];
  const idx = (name: string) => data.headers.indexOf(name);
  const add = (
    row: Row,
    col: string,
    title: string,
    detail: string,
    evidence: string[],
    kind: Finding['kind'],
    patch?: Patch,
  ) =>
    out.push({
      id: `${check}:${row.id}:${col}`,
      check,
      rowId: row.id,
      column: col,
      title,
      detail,
      evidence,
      kind,
      ...(patch ? { patch } : {}),
    });
  if (check === 'duplicates') {
    const col = idx(r.idColumn),
      groups = new Map<string, Row[]>();
    for (const row of data.rows) {
      const id = row.cells[col];
      if (isMissing(id, r)) {
        add(
          row,
          r.idColumn,
          'Missing record ID',
          'No record identity can be established.',
          [`Record ${row.id}: ${show(id)}`],
          'issue',
        );
        continue;
      }
      groups.set(id, [...(groups.get(id) ?? []), row]);
    }
    for (const [id, rows] of groups) {
      if (rows.length < 2) continue;
      const same = rows.every((row) =>
        row.cells.every((v, i) => v === rows[0].cells[i]),
      );
      for (const row of same ? rows.slice(1) : rows) {
        if (same && r.uniqueIds)
          add(
            row,
            r.idColumn,
            'Exact duplicate record',
            `Keep record ${rows[0].id}; remove the extra copy from the working dataset.`,
            [
              `Sale ID ${show(id)} appears ${rows.length} times.`,
              `Every field matches record ${rows[0].id}.`,
              'Confirmed rule: one record per unique ID.',
            ],
            'repair',
            {
              rowId: row.id,
              changes: [],
              deleteRow: true,
              snapshot: [...row.cells],
              dependencies: [{ id: rows[0].id, cells: [...rows[0].cells] }],
            },
          );
        else
          add(
            row,
            r.idColumn,
            same
              ? 'Repeated ID needs a rule'
              : 'Conflicting records share an ID',
            same
              ? 'Confirm that each ID must identify one record before deleting anything.'
              : 'The records disagree. A human must decide which source is correct.',
            [
              `ID: ${show(id)}`,
              `Related records: ${rows.map((x) => x.id).join(', ')}`,
              same
                ? 'Fields match; uniqueness is not confirmed.'
                : 'Different values exist under the same ID.',
            ],
            'review',
          );
      }
    }
  }
  if (check === 'arithmetic') {
    const q = idx(r.quantityColumn),
      p = idx(r.priceColumn),
      t = idx(r.totalColumn);
    for (const row of data.rows) {
      if (!isMissing(row.cells[q], r)) continue;
      const answer =
        isMissing(row.cells[t], r) || isMissing(row.cells[p], r)
          ? null
          : exactQuantity(row.cells[t], row.cells[p]);
      if (answer)
        add(
          row,
          r.quantityColumn,
          'Recover a missing quantity',
          `Replace ${show(row.cells[q])} with ${answer}.`,
          [
            `Total ${show(row.cells[t])} ÷ unit price ${show(row.cells[p])} = ${answer}.`,
            'Confirmed rule: total = quantity × price; no taxes, discounts or refunds.',
            'The result is an exact positive integer; price and total are trusted.',
          ],
          'repair',
          {
            rowId: row.id,
            changes: [{ column: q, before: row.cells[q], after: answer }],
            dependencies: [{ id: row.id, cells: [...row.cells] }],
          },
        );
      else
        add(
          row,
          r.quantityColumn,
          'Quantity cannot be recovered',
          'The available fields do not prove a positive whole-number quantity.',
          [
            `Price: ${show(row.cells[p])}; total: ${show(row.cells[t])}.`,
            'No rounding or guessed quantity is allowed.',
          ],
          'review',
        );
    }
  }
  if (check === 'dates') {
    const col = idx(r.dateColumn);
    for (const row of data.rows) {
      const v = row.cells[col];
      if (isMissing(v, r)) continue;
      if (!validDate(v))
        add(
          row,
          r.dateColumn,
          'Invalid or differently formatted date',
          'Check the source document. The investigator will not guess a date.',
          [
            `Observed: ${show(v)}`,
            'Expected format: YYYY-MM-DD.',
            'A valid calendar day must exist in the stated month and year.',
          ],
          'issue',
        );
    }
  }
  if (check === 'categories') {
    const col = idx(r.categoryColumn);
    for (const row of data.rows) {
      const v = row.cells[col];
      if (isMissing(v, r)) continue;
      const canonical = r.categories.find(
        (c) => c.toLowerCase().trim() === v.toLowerCase().trim(),
      );
      if (canonical && canonical !== v)
        add(
          row,
          r.categoryColumn,
          'Normalize a category label',
          `Use the approved label ${canonical}.`,
          [
            `Observed: “${show(v)}”`,
            `Approved vocabulary: ${r.categories.join(', ')}`,
            'Only surrounding spaces and letter case differ.',
          ],
          'repair',
          {
            rowId: row.id,
            changes: [{ column: col, before: v, after: canonical }],
          },
        );
      else if (!canonical)
        add(
          row,
          r.categoryColumn,
          'Unknown category',
          'The label does not match an approved category. No fuzzy replacement will be made.',
          [
            `Observed: ${show(v)}`,
            `Approved labels: ${r.categories.join(', ')}`,
          ],
          'review',
        );
    }
  }
  if (check === 'units') {
    const v = idx(r.valueColumn),
      u = idx(r.unitColumn);
    for (const row of data.rows) {
      const raw = row.cells[v],
        unit = row.cells[u];
      if (isMissing(raw, r)) continue;
      if (unit === r.targetUnit) continue;
      const answer = convertMass(raw, unit, r.targetUnit);
      if (answer !== null)
        add(
          row,
          r.valueColumn,
          'Convert an explicit mass unit',
          `Convert ${show(raw)} ${show(unit)} to ${answer} ${r.targetUnit}.`,
          [
            `The source unit is explicitly “${show(unit)}”.`,
            'Confirmed conversion: 1 kg = 1,000 g.',
            'The value and unit change together.',
          ],
          'repair',
          {
            rowId: row.id,
            changes: [
              { column: v, before: raw, after: answer },
              { column: u, before: unit, after: r.targetUnit },
            ],
          },
        );
      else
        add(
          row,
          r.valueColumn,
          'Unit needs human review',
          'Only declared grams/kilograms conversions are supported. The unit will not be inferred from magnitude.',
          [
            `Value: ${show(raw)}; unit: ${show(unit)}`,
            `Requested unit: ${r.targetUnit}`,
          ],
          'review',
        );
    }
  }
  if (check === 'outliers') {
    const col = idx(r.outlierColumn),
      values = data.rows
        .filter((row) => !isMissing(row.cells[col], r))
        .map((row) => numberValue(row.cells[col]))
        .filter((x): x is number => x !== null)
        .sort((a, b) => a - b);
    if (values.length >= 4) {
      const q1 = quantile(values, 0.25),
        q3 = quantile(values, 0.75),
        iqr = q3 - q1,
        low = q1 - outlierMultiplier(r) * iqr,
        high = q3 + outlierMultiplier(r) * iqr;
      for (const row of data.rows) {
        const n = isMissing(row.cells[col], r)
          ? null
          : numberValue(row.cells[col]);
        if (n !== null && (n < low || n > high))
          add(
            row,
            r.outlierColumn,
            'Unusual value · not proven wrong',
            'Keep the value unless source evidence supports a correction.',
            [
              `Observed: ${n}; reference cohort: ${values.length} numeric records.`,
              `Q1 ${q1.toFixed(2)}, Q3 ${q3.toFixed(2)}; ${outlierMultiplier(r)} × IQR interval: ${low.toFixed(2)} to ${high.toFixed(2)}.`,
              'A statistical outlier may be a legitimate large order.',
            ],
            'review',
          );
      }
    }
  }
  return out.map((f) => ({
    ...f,
    ...findingMeta(f),
    priority: findingPriority(f),
  }));
}

export function applyPatch(data: Dataset, patch: Patch): Dataset {
  for (const dependency of patch.dependencies ?? []) {
    const actual = data.rows.find((x) => x.id === dependency.id);
    if (
      !actual ||
      JSON.stringify(actual.cells) !== JSON.stringify(dependency.cells)
    )
      throw new Error(
        'The evidence changed after detection. Re-run the investigation.',
      );
  }
  const row = data.rows.find((x) => x.id === patch.rowId);
  if (!row)
    throw new Error('This record no longer exists. Re-run the investigation.');
  if (patch.deleteRow) {
    if (
      !patch.snapshot ||
      JSON.stringify(patch.snapshot) !== JSON.stringify(row.cells)
    )
      throw new Error(
        'This duplicate changed after detection. Re-run the investigation.',
      );
    return { ...data, rows: data.rows.filter((x) => x.id !== patch.rowId) };
  }
  for (const c of patch.changes)
    if (
      c.column < 0 ||
      c.column >= data.headers.length ||
      row.cells[c.column] !== c.before
    )
      throw new Error(
        'The value changed after detection. Re-run the investigation.',
      );
  return {
    ...data,
    rows: data.rows.map((x) =>
      x.id !== patch.rowId
        ? x
        : {
            ...x,
            cells: x.cells.map(
              (v, i) => patch.changes.find((c) => c.column === i)?.after ?? v,
            ),
          },
    ),
  };
}
export function materialize(original: Dataset, decisions: Decision[]) {
  return decisions.reduce(
    (data, d) =>
      d.action === 'apply' && d.finding.patch
        ? applyPatch(data, d.finding.patch)
        : data,
    original,
  );
}
export function allFindings(data: Dataset, r: Rules) {
  return availableChecks(r).flatMap((c) => inspectCheck(data, r, c));
}
export function csvCell(v: string) {
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
export function toCSV(data: Dataset) {
  return (
    [data.headers, ...data.rows.map((x) => x.cells)]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n') + '\r\n'
  );
}
export function ledgerCSV(data: Dataset, decisions: Decision[]) {
  const rows = [
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
    ],
  ];
  for (const d of decisions) {
    const f = d.finding;
    if (d.action === 'apply' && f.patch) {
      if (f.patch.deleteRow)
        rows.push([
          d.at,
          String(f.rowId),
          f.check,
          'removed duplicate',
          '*',
          JSON.stringify(f.patch.snapshot),
          '',
          f.evidence.join(' | '),
          d.note,
        ]);
      else
        for (const c of f.patch.changes)
          rows.push([
            d.at,
            String(f.rowId),
            f.check,
            'replaced value',
            data.headers[c.column],
            c.before,
            c.after,
            f.evidence.join(' | '),
            d.note,
          ]);
    } else
      rows.push([
        d.at,
        String(f.rowId),
        f.check,
        'kept unchanged',
        f.column,
        '',
        '',
        f.evidence.join(' | '),
        d.note,
      ]);
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export function parseAnswerKey(text: string): KeyEntry[] {
  const data = parseCSV(text, 'answer-key.csv');
  const ri = data.headers.indexOf('row'),
    ci = data.headers.indexOf('check'),
    ti = data.headers.indexOf('truth');
  if ([ri, ci, ti].some((x) => x < 0))
    throw new Error('Answer key needs columns: row,check,truth.');
  const seen = new Set<string>();
  return data.rows.map((r) => {
    const row = Number(r.cells[ri]),
      check = r.cells[ci] as Check,
      truth = r.cells[ti] as KeyEntry['truth'];
    if (
      !Number.isSafeInteger(row) ||
      row < 1 ||
      !CHECKS.includes(check) ||
      !['defect', 'valid'].includes(truth)
    )
      throw new Error(
        'Answer-key rows need a positive record number, a supported check, and defect or valid.',
      );
    const id = row + ':' + check;
    if (seen.has(id))
      throw new Error('The answer key repeats a row/check pair.');
    seen.add(id);
    return { row, check, truth };
  });
}
export function scoreAnswerKey(key: KeyEntry[], findings: Finding[]) {
  return key.map((k) => {
    const f = findings.find((f) => f.rowId === k.row && f.check === k.check);
    const asserted = f && f.kind !== 'review';
    return {
      ...k,
      result:
        k.truth === 'defect'
          ? asserted
            ? 'caught'
            : f
              ? 'flagged for review'
              : 'missed'
          : asserted
            ? 'falsely flagged'
            : f
              ? 'review requested'
              : 'preserved',
    };
  });
}
