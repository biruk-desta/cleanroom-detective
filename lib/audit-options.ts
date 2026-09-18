import type { Finding, Rules, Dataset } from './audit.ts';

export type AuditOptions = {
  goal: string;
  domain:
    | 'custom'
    | 'cafe'
    | 'employees'
    | 'sensors'
    | 'finance'
    | 'sports'
    | 'science';
  sensitivity: 'broad' | 'balanced' | 'strict';
  required: string[];
  emailColumn: string;
  rangeColumn: string;
  minimum: number | null;
  maximum: number | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
};
export const DEFAULT_OPTIONS: AuditOptions = {
  goal: '',
  domain: 'custom',
  sensitivity: 'balanced',
  required: [],
  emailColumn: '',
  rangeColumn: '',
  minimum: null,
  maximum: null,
  severity: 'high',
};
export const DOMAINS = {
  custom: 'General / custom',
  cafe: 'Café sales',
  employees: 'Employee records',
  sensors: 'Device sensors',
  finance: 'Finance',
  sports: 'Sports',
  science: 'Scientific tables',
};
export const optionsFor = (r: Rules): AuditOptions => ({
  ...DEFAULT_OPTIONS,
  ...r.audit,
});
export function validateOptions(r: Rules, headers: string[]) {
  if (!r.audit) return;
  const a = optionsFor(r);
  if (
    !Object.keys(DOMAINS).includes(a.domain) ||
    !['broad', 'balanced', 'strict'].includes(a.sensitivity) ||
    !['low', 'medium', 'high', 'critical'].includes(a.severity) ||
    typeof a.goal !== 'string' ||
    a.goal.length > 1000
  )
    throw new Error('Check the audit goal, profile, and sensitivity.');
  if (
    !Array.isArray(a.required) ||
    a.required.length > headers.length ||
    new Set(a.required).size !== a.required.length ||
    a.required.some((c) => !headers.includes(c)) ||
    ![a.emailColumn, a.rangeColumn].every(
      (c) => typeof c === 'string' && (!c || headers.includes(c)),
    )
  )
    throw new Error('Choose existing columns for your custom checks.');
  for (const n of [a.minimum, a.maximum])
    if (n !== null && (typeof n !== 'number' || !Number.isFinite(n)))
      throw new Error('Numeric limits must be finite numbers.');
  if (a.minimum !== null && a.maximum !== null && a.minimum > a.maximum)
    throw new Error('The minimum cannot exceed the maximum.');
}
export const outlierMultiplier = (r: Rules) =>
  ({ broad: 1, balanced: 1.5, strict: 3 })[optionsFor(r).sensitivity];
export function suggestOptions(
  headers: string[],
  current: Rules,
  goal: string,
  domain: AuditOptions['domain'],
): Rules {
  const text = goal.toLowerCase();
  if (domain === 'custom') {
    if (/employee|staff|email/.test(text)) domain = 'employees';
    else if (/sensor|temperature|device/.test(text)) domain = 'sensors';
    else if (/café|cafe|sales|price/.test(text)) domain = 'cafe';
    else if (/finance|account|transaction/.test(text)) domain = 'finance';
    else if (/sport|score/.test(text)) domain = 'sports';
    else if (/science|research|experiment/.test(text)) domain = 'science';
  }
  const find = (...words: string[]) =>
    headers.find((h) =>
      words.includes(h.toLowerCase().replace(/[ -]/g, '_')),
    ) || '';
  const audit = { ...optionsFor(current), goal, domain };
  if (domain === 'employees' || /email/.test(text))
    audit.emailColumn = find('email', 'email_address', 'work_email');
  const outlierColumn =
    current.outlierColumn ||
    (domain === 'sensors'
      ? find('temperature', 'humidity', 'value', 'reading')
      : find('amount', 'score', 'value'));
  return {
    ...current,
    audit,
    outlierColumn,
    idColumn:
      current.idColumn ||
      find('employee_id', 'sensor_id', 'transaction_id', 'sample_id', 'id'),
    missingTokens: [
      ...new Set([...current.missingTokens, 'N/A', 'NULL', 'null', '?']),
    ],
  };
}
export function customFindings(
  data: Dataset,
  rules: Rules,
  check: 'required' | 'email' | 'range',
): Finding[] {
  const a = optionsFor(rules),
    out: Finding[] = [];
  for (const row of data.rows) {
    const columns =
      check === 'required'
        ? a.required
        : [check === 'email' ? a.emailColumn : a.rangeColumn];
    for (const column of columns) {
      if (!column) continue;
      const raw = row.cells[data.headers.indexOf(column)],
        missing = rules.missingTokens.includes(raw.trim());
      let detail = '';
      if (check === 'required' && missing)
        detail =
          'This field is required by your confirmed rules, but contains a missing-value marker.';
      if (
        check === 'email' &&
        !missing &&
        !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(raw)
      )
        detail =
          'This does not match a basic email structure. Verify the address with an approved source; no contact was made.';
      if (check === 'range' && !missing) {
        const n = /^-?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
        if (!Number.isFinite(n))
          detail =
            'A plain numeric value is expected. Check decimal separators and currency labels before converting.';
        else if (
          (a.minimum !== null && n < a.minimum) ||
          (a.maximum !== null && n > a.maximum)
        )
          detail = `Outside your confirmed range: ${a.minimum ?? 'no lower limit'} to ${a.maximum ?? 'no upper limit'}.`;
      }
      if (detail)
        out.push({
          id: `${check}:${row.id}:${column}`,
          check,
          rowId: row.id,
          column,
          title:
            check === 'required'
              ? 'Required value is missing'
              : check === 'email'
                ? 'Check this email address'
                : 'Outside the numeric rule',
          detail,
          evidence: [
            `Observed: ${raw || '(empty)'}`,
            detail,
            'A verified source is needed to choose a replacement.',
          ],
          kind: 'issue',
          severity: a.severity,
          confidence: 'Rule match',
        });
    }
  }
  return out;
}
export function findingMeta(f: Finding) {
  return {
    severity:
      f.severity ?? (f.kind === 'issue' ? 'high' : f.patch ? 'medium' : 'low'),
    confidence:
      f.confidence ??
      (f.patch
        ? 'Supported correction'
        : f.kind === 'issue'
          ? 'Rule match'
          : 'Needs judgment'),
  };
}
export function findingPriority(f: Finding) {
  const m = findingMeta(f);
  return (
    { critical: 4, high: 3, medium: 2, low: 1 }[m.severity] * 10 +
    (f.patch ? 2 : f.kind === 'issue' ? 1 : 0)
  );
}
export function similarFindings(
  findings: Finding[],
  target: Finding,
): Finding[] {
  if (!target.patch || target.patch.deleteRow) return [];
  const signature = (f: Finding) =>
    JSON.stringify([
      f.check,
      f.column,
      f.title,
      f.patch?.changes.map((c) => c.column),
    ]);
  return findings
    .filter(
      (f) =>
        f.patch && !f.patch.deleteRow && signature(f) === signature(target),
    )
    .slice(0, 30);
}
export function unresolvedCSV(
  findings: Finding[],
  decisions: { finding: Finding; action?: string; note?: string }[],
) {
  const status = (f: Finding) => decisions.find((d) => d.finding.id === f.id);
  const cell = (v: string) => '"' + v.replace(/"/g, '""') + '"';
  return (
    [
      [
        'row',
        'column',
        'check',
        'severity',
        'evidence_strength',
        'issue',
        'evidence',
        'review_status',
        'reviewer_note',
      ],
      ...findings.map((f) => [
        String(f.rowId),
        f.column,
        f.check,
        findingMeta(f).severity,
        findingMeta(f).confidence,
        f.detail,
        f.evidence.join(' | '),
        status(f)?.action === 'keep' ? 'Kept unchanged' : 'Needs review',
        status(f)?.note || '',
      ]),
    ]
      .map((r) => r.map(cell).join(','))
      .join('\r\n') + '\r\n'
  );
}
