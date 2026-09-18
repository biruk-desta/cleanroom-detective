import { csvCell, parseCSV } from './audit.ts';
export type ConvertedFile = {
  sheets: { name: string; csv: string }[];
  warnings: string[];
};
const tableCSV = (rows: string[][]) =>
  rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
export function jsonCSV(text: string) {
  // JSON.parse's source context preserves numeric identifiers exactly, including >2^53.
  const parse = JSON.parse as (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context?: { source?: string },
    ) => unknown,
  ) => unknown;
  const data = parse(text, (_key, value, context) => {
    if (typeof value === 'number') {
      if (
        !context?.source &&
        (!Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value)))
      )
        throw new Error(
          'This browser cannot preserve a large JSON number. Quote numeric IDs as strings, or export CSV.',
        );
      return context?.source ?? String(value);
    }
    return value;
  });
  if (
    !Array.isArray(data) ||
    !data.length ||
    data.length > 5000 ||
    data.some((r) => !r || typeof r !== 'object' || Array.isArray(r))
  )
    throw new Error(
      'Use a JSON array of 1–5,000 flat objects, one object per row.',
    );
  const headers = [...new Set(data.flatMap((r) => Object.keys(r)))];
  const rows = data.map((r) =>
    headers.map((h) => {
      const v = Object.hasOwn(r, h) ? r[h] : undefined;
      if (v !== null && typeof v === 'object')
        throw new Error(
          `Nested JSON in “${h}” needs flattening before import.`,
        );
      return v == null ? '' : String(v);
    }),
  );
  const csv = tableCSV([headers, ...rows]);
  parseCSV(csv);
  return csv;
}
export async function convertFile(file: File): Promise<ConvertedFile> {
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension === 'csv')
    return { sheets: [{ name: 'CSV', csv: await file.text() }], warnings: [] };
  if (extension === 'json') {
    if (file.size > 1_000_000)
      throw new Error(
        'JSON conversion supports files up to 1 MB. Export larger tables as CSV for the large-file workspace.',
      );
    return {
      sheets: [{ name: 'JSON table', csv: jsonCSV(await file.text()) }],
      warnings: [
        'JSON null and missing properties become empty cells. Numeric text is preserved; nested objects are not supported.',
      ],
    };
  }
  if (!['xlsx', 'xls'].includes(extension || ''))
    throw new Error('Choose a CSV, Excel (.xlsx or .xls), or JSON file.');
  if (file.size > 10_000_000)
    throw new Error(
      'Excel conversion supports workbooks up to 10 MB. Export a larger sheet as CSV.',
    );
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: 'array',
    sheetRows: 5002,
    cellText: true,
    cellFormula: true,
  });
  if (workbook.SheetNames.length > 20)
    throw new Error(
      'Choose a workbook with up to 20 sheets, or export the required sheet as CSV.',
    );
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const range = XLSX.utils.decode_range(
      sheet['!fullref'] || sheet['!ref'] || 'A1',
    );
    if (range.e.r - range.s.r > 5000 || range.e.c - range.s.c >= 40)
      return { name, csv: '' };
    const values = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    const width = Math.max(...values.map((r) => r.length), 0);
    return {
      name,
      csv: tableCSV(
        values.map((r) =>
          Array.from({ length: width }, (_, i) => String(r[i] ?? '')),
        ),
      ),
    };
  });
  return {
    sheets,
    warnings: [
      'Choose the worksheet to check. Import uses displayed cell values, including number/date formatting. Formulas are not executed; saved results are used when present. Formatting, charts, and extra sheets remain in your original workbook.',
      'Excel conversion supports 5,000 rows, 40 columns, and 1 MB of converted CSV per sheet. For larger sheets, export CSV and use the large-file workspace.',
    ],
  };
}
