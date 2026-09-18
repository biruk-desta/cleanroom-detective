'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ScanSearch,
  FileSpreadsheet,
  Upload,
  ShieldCheck,
  Check as CheckIcon,
  ArrowRight,
  Download,
  Settings2,
  RotateCcw,
  Search,
  CircleHelp,
  CheckCircle2,
  AlertCircle,
  X,
  FlaskConical,
  ChevronRight,
  ListChecks,
  Table2,
  History,
  SlidersHorizontal,
  Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  SAMPLE_CSV,
  SAMPLE_RULES,
  CHECKS,
  CHECK_NAMES,
  parseCSV,
  inferRules,
  validateRules,
  profile,
  availableChecks,
  inspectCheck,
  allFindings,
  applyPatch,
  materialize,
  toCSV,
  ledgerCSV,
  parseAnswerKey,
  scoreAnswerKey,
  type Rules,
  type Finding,
  type Decision,
  type Trace,
  type KeyEntry,
  type Check,
} from '@/lib/audit';
import {
  findingMeta,
  findingPriority,
  similarFindings,
  unresolvedCSV,
} from '@/lib/audit-options';
import { convertFile, type ConvertedFile } from '@/lib/import-file';
import { reportHTML, printReport } from '@/lib/report';
import { STATIC_DEMO, publicAsset } from '@/lib/runtime';
import { Welcome } from '@/components/cleanroom/welcome';
import { CheckSettings } from '@/components/cleanroom/check-settings';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { Progress } from '@/components/ui/progress';
const INITIAL = parseCSV(SAMPLE_CSV, 'cafe-sales-practice.csv');
const CHECK_LABELS: Record<Check, string> = {
  duplicates: 'Repeated rows',
  arithmetic: 'Missing quantities',
  dates: 'Dates',
  categories: 'Names & categories',
  units: 'Grams & kilograms',
  outliers: 'Unusual numbers',
  required: 'Required fields',
  email: 'Email structure',
  range: 'Numeric limits',
};
const friendlyTitle = (f: Finding) =>
  ({
    duplicates: f.patch
      ? 'This row appears twice'
      : f.title === 'Missing record ID'
        ? 'A row is missing its ID'
        : 'These IDs need a closer look',
    arithmetic: f.patch
      ? 'Fill in a missing quantity'
      : 'A quantity needs checking',
    dates: 'This date needs checking',
    categories: f.patch
      ? 'Make this label consistent'
      : 'Check this category name',
    units: f.patch ? 'Use the same unit' : 'Check this measurement',
    outliers: 'An unusual value to double-check',
    required: 'Fill a required field',
    email: 'Check this email address',
    range: 'Check this numeric value',
  })[f.check];
const label = (f: Finding) => (f.patch ? 'Suggested fix' : 'Take a look');
const err = (e: unknown) =>
  e instanceof Error ? e.message : 'Something went wrong. Please try again.';
function download(name: string, body: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Home({
  onLargeFile,
  onOpenLarge,
}: { onLargeFile?: (file: File) => void; onOpenLarge?: () => void } = {}) {
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [conversion, setConversion] = useState<{
    file: File;
    result: ConvertedFile;
  } | null>(null);
  const [conversionWarnings, setConversionWarnings] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [hasFile, setHasFile] = useState(false);
  const [original, setOriginal] = useState(INITIAL),
    [rules, setRules] = useState<Rules>(SAMPLE_RULES),
    [draft, setDraft] = useState<Rules>(SAMPLE_RULES),
    [decisions, setDecisions] = useState<Decision[]>([]),
    [findings, setFindings] = useState<Finding[]>([]),
    [frozen, setFrozen] = useState<Finding[]>([]),
    [traces, setTraces] = useState<Trace[]>([]);
  const [selectedId, setSelectedId] = useState(''),
    [tab, setTab] = useState('findings'),
    [ran, setRan] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState('Ready to investigate'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [note, setNote] = useState(''),
    [manual, setManual] = useState(''),
    [summary, setSummary] = useState(''),
    [filter, setFilter] = useState('pending'),
    [search, setSearch] = useState('');
  const [ruleOpen, setRuleOpen] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [keyOpen, setKeyOpen] = useState(false),
    [answerKey, setAnswerKey] = useState<KeyEntry[]>([]),
    [model, setModel] = useState({
      configured: false,
      model: '',
      provider: '',
    });
  const uploadRef = useRef<HTMLInputElement>(null),
    keyRef = useRef<HTMLInputElement>(null),
    abortRef = useRef<AbortController | null>(null),
    running = useRef(false),
    baseline = useRef(false);
  const data = useMemo(
    () => materialize(original, decisions),
    [original, decisions],
  );
  const combined = useMemo(() => {
    const m = new Map(findings.map((f) => [f.id, f]));
    decisions.forEach((d) => {
      if (!m.has(d.finding.id)) m.set(d.finding.id, d.finding);
    });
    return [...m.values()].sort(
      (a, b) => findingPriority(b) - findingPriority(a) || a.rowId - b.rowId,
    );
  }, [findings, decisions]);
  const pending = combined.filter(
    (f) => !decisions.some((d) => d.finding.id === f.id),
  );
  const visible = combined.filter(
    (f) =>
      (filter === 'all' ||
        (filter === 'pending'
          ? !decisions.some((d) => d.finding.id === f.id)
          : filter === 'repair'
            ? f.kind === 'repair'
            : f.kind !== 'repair')) &&
      `${f.rowId} ${f.title} ${f.column}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const selected = visible.find((f) => f.id === selectedId) ?? visible[0],
    decision = decisions.find((d) => d.finding.id === selected?.id);
  const activeChecks = availableChecks(rules);
  const applied = decisions.filter((d) => d.action === 'apply').length;
  useEffect(() => {
    if (STATIC_DEMO) return;
    fetch('/api/status')
      .then((r) => r.json())
      .then((v) =>
        setModel(v as { configured: boolean; model: string; provider: string }),
      )
      .catch(() => {});
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(''), 6500);
      return () => clearTimeout(t);
    }
  }, [notice]);
  function reset(
    text = SAMPLE_CSV,
    name = 'cafe-sales-practice.csv',
    sample = true,
  ) {
    try {
      const next = parseCSV(text, name);
      setSourceFile(null);
      setConversionWarnings([]);
      setOriginal(next);
      setHasFile(true);
      const r = sample ? SAMPLE_RULES : inferRules(next.headers);
      setRules(r);
      setDraft(r);
      setDecisions([]);
      setFindings([]);
      setFrozen([]);
      baseline.current = false;
      setNote('');
      setManual('');
      setTraces([]);
      setAnswerKey([]);
      setRan(false);
      setSummary('');
      setSelectedId('');
      setStatus('Ready to investigate');
      setError('');
      setSearch('');
      setFilter('pending');
      setTab('findings');
      setRuleOpen(false);
      setNotice(
        sample
          ? 'The example is ready. Check the file to see what we find.'
          : 'Your file is ready. You can choose which checks to run.',
      );
    } catch (e) {
      setError(err(e));
    }
  }
  function saveRules() {
    try {
      const confirmed = {
        ...draft,
        categories: draft.categories.map((c) => c.trim()).filter(Boolean),
      };
      validateRules(confirmed, data.headers);
      setRules(confirmed);
      setFindings([]);
      setRan(false);
      setSummary('');
      setRuleOpen(false);
      setError('');
      setStatus('Rules updated · ready to investigate');
    } catch (e) {
      setError(err(e));
    }
  }
  async function investigate(mode: 'rules' | 'ai') {
    if (running.current || answerKey.length) return;
    running.current = true;
    setBusy(true);
    setError('');
    setTraces([]);
    setFindings([]);
    setNote('');
    setManual('');
    setSummary('');
    setTab('findings');
    setFilter('pending');
    setSearch('');
    setStatus(
      mode === 'ai'
        ? 'AI investigator choosing a check…'
        : 'Running declared checks…',
    );
    setRan(false);
    try {
      validateRules(rules, data.headers);
      if (!availableChecks(rules).length)
        throw new Error('Map and enable at least one data rule.');
      if (mode === 'rules') {
        const ts: Trace[] = [
          {
            step: 1,
            tool: 'profile_dataset',
            summary: `Measured ${data.rows.length} records across ${data.headers.length} columns.`,
            findings: 0,
            at: new Date().toISOString(),
          },
        ];
        const fs = availableChecks(rules).flatMap((c) => {
          const out = inspectCheck(data, rules, c);
          ts.push({
            step: ts.length + 1,
            tool: c,
            summary: `${CHECK_NAMES[c]}: ${out.length} finding(s).`,
            findings: out.length,
            at: new Date().toISOString(),
          });
          return out;
        });
        setTraces(ts);
        setFindings(fs);
        if (!baseline.current) {
          setFrozen(fs);
          baseline.current = true;
        }
        setSelectedId(
          [...fs].sort(
            (a, b) =>
              findingPriority(b) - findingPriority(a) || a.rowId - b.rowId,
          )[0]?.id ?? '',
        );
        setRan(true);
        setSummary(
          `Checked ${data.rows.length.toLocaleString()} rows using ${activeChecks.length} confirmed checks. Found ${fs.filter((f) => f.patch).length} suggested fixes and ${fs.filter((f) => !f.patch).length} items needing judgment. Your original file is unchanged.`,
        );
        setStatus('Rules audit complete');
      } else {
        const controller = new AbortController();
        abortRef.current = controller;
        const response = await fetch('/api/investigate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            csv: toCSV(data),
            name: original.name,
            rowIds: data.rows.map((r) => r.id),
            rules,
          }),
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(
            ((await response.json()) as { error?: string }).error ||
              'Investigation could not start.',
          );
        if (!response.body)
          throw new Error('No investigation stream received.');
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let buffer = '',
          done = false;
        const accept = (line: string) => {
          if (!line.trim()) return;
          const e = JSON.parse(line);
          if (e.type === 'error') throw new Error(e.error);
          if (e.type === 'trace') {
            setTraces((t) => [...t, e.trace]);
            setStatus(e.trace.summary);
          }
          if (e.type === 'findings') setFindings(e.findings);
          if (e.type === 'done') {
            setFindings(e.findings);
            if (!baseline.current) {
              setFrozen(e.findings);
              baseline.current = true;
            }
            setSummary(e.summary);
            setSelectedId(
              [...(e.findings as Finding[])].sort(
                (a, b) =>
                  findingPriority(b) - findingPriority(a) || a.rowId - b.rowId,
              )[0]?.id ?? '',
            );
            setRan(true);
            setStatus('AI investigation complete');
            done = true;
          }
        };
        while (true) {
          const r = await reader.read();
          buffer += decoder.decode(r.value, { stream: !r.done });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          lines.forEach(accept);
          if (r.done) break;
        }
        if (buffer) accept(buffer);
        if (!done)
          throw new Error(
            'Investigation stopped before completion. Run again.',
          );
      }
    } catch (e) {
      const stopped = e instanceof Error && e.name === 'AbortError';
      setError(
        stopped
          ? 'Checking stopped. You can try again or use standard checks.'
          : err(e),
      );
      setStatus('Investigation incomplete');
      setFindings(ran ? findings : []);
      if (ran) {
        setRan(true);
        setTraces(traces);
        setSummary(summary);
      }
    } finally {
      running.current = false;
      setBusy(false);
      abortRef.current = null;
    }
  }
  function decide(action: 'apply' | 'keep', human = false) {
    if (!selected || decision || busy) return;
    try {
      let f = selected;
      if (human) {
        if (!note.trim() || !manual.trim())
          throw new Error(
            'Enter the source-verified value and describe its source.',
          );
        const col = data.headers.indexOf(f.column),
          row = data.rows.find((r) => r.id === f.rowId);
        if (!row || col < 0) throw new Error('Record unavailable.');
        if (manual.length > 4000)
          throw new Error('Keep the correction under 4,000 characters.');
        f = {
          ...f,
          patch: {
            rowId: f.rowId,
            changes: [{ column: col, before: row.cells[col], after: manual }],
          },
          evidence: [...f.evidence, `Human-provided source: ${note}`],
        };
      }
      if (action === 'apply' && !f.patch)
        throw new Error('This finding needs source evidence.');
      const next = action === 'apply' ? applyPatch(data, f.patch!) : data;
      const rechecked = allFindings(next, rules);
      if (human && rechecked.some((x) => x.id === f.id))
        throw new Error(
          'The supplied correction still triggers this check. Verify the source or keep the value with an explanation.',
        );
      setDecisions((d) => [
        ...d,
        {
          id: crypto.randomUUID(),
          finding: f,
          action,
          note:
            note.trim() ||
            (action === 'keep'
              ? 'Kept unchanged by the reviewer; no correction was verified.'
              : ''),
          at: new Date().toISOString(),
        },
      ]);
      setFindings(rechecked);
      setTraces((t) => [
        ...t,
        {
          step: t.length + 1,
          tool: 'recheck_after_decision',
          summary: `Record ${f.rowId}: ${action === 'apply' ? 'approved repair applied' : 'kept unchanged'}. ${rechecked.length} findings remain in the working data.`,
          findings: rechecked.length,
          at: new Date().toISOString(),
        },
      ]);
      const nextItem = rechecked.find(
        (item) =>
          item.id !== f.id && !decisions.some((d) => d.finding.id === item.id),
      );
      setSelectedId(nextItem?.id ?? f.id);
      setNote('');
      setManual('');
      setNotice(
        action === 'apply'
          ? 'Change applied. Your original is still safe.'
          : 'Kept as is. We saved your decision.',
      );
      setError('');
    } catch (e) {
      setError(err(e));
    }
  }
  const similar = selected ? similarFindings(pending, selected) : [];
  function applySimilar() {
    try {
      if (!similar.length) return;
      let next = data;
      for (const f of similar) next = applyPatch(next, f.patch!);
      const batchId = crypto.randomUUID();
      setDecisions((d) => [
        ...d,
        ...similar.map((f) => ({
          id: crypto.randomUUID(),
          finding: f,
          action: 'apply' as const,
          note: note.trim() || 'Approved after previewing this batch.',
          at: new Date().toISOString(),
          batchId,
        })),
      ]);
      setFindings(allFindings(next, rules));
      setBulkOpen(false);
      setNotice(
        `${similar.length} approved changes applied. Undo reverses this whole batch.`,
      );
    } catch (e) {
      setError(err(e));
    }
  }
  function undo() {
    try {
      const last = decisions.at(-1);
      const next = last?.batchId
        ? decisions.filter((d) => d.batchId !== last.batchId)
        : decisions.slice(0, -1);
      setFindings(allFindings(materialize(original, next), rules));
      setSelectedId(decisions.at(-1)?.finding.id ?? '');
      setFilter('pending');
      setSearch('');
      setNote('');
      setManual('');
      setError('');
      setTab('findings');
      setDecisions(next);
      setNotice('Last decision undone. The prior working values are restored.');
    } catch (e) {
      setError(err(e));
    }
  }
  const stateRef = useRef({ data, rules });
  useEffect(() => {
    stateRef.current = { data, rules };
  }, [data, rules]);
  useEffect(() => {
    type Context = {
      registerTool: (
        tool: Record<string, unknown>,
        options: { signal: AbortSignal },
      ) => unknown;
    };
    const context = (document as unknown as { modelContext?: Context })
      .modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const registration = context.registerTool(
      {
        name: 'get_case_profile',
        title: 'Read current case profile',
        description:
          'Read measured column statistics and active checks for the working CSV. Does not change the dataset or run an investigation.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute(input: unknown) {
          if (
            !input ||
            typeof input !== 'object' ||
            Array.isArray(input) ||
            Object.keys(input).length
          )
            throw new Error('Expected an empty object.');
          return profile(stateRef.current.data, stateRef.current.rules);
        },
      },
      { signal: lifecycle.signal },
    );
    Promise.resolve(registration).catch(() => {});
    return () => lifecycle.abort();
  }, []);
  async function revealKey(file: File) {
    try {
      const key = parseAnswerKey(await file.text());
      if (key.some((k) => !original.rows.some((r) => r.id === k.row)))
        throw new Error('The answer key refers to a record outside this case.');
      setAnswerKey(key);
      setError('');
    } catch (e) {
      setError(err(e));
    }
  }
  async function loadFile(file?: File) {
    if (!file) return;
    try {
      setError('');
      if (
        file.name.toLowerCase().endsWith('.csv') &&
        file.size > 1_000_000 &&
        onLargeFile
      ) {
        onLargeFile(file);
        return;
      }
      if (file.name.toLowerCase().endsWith('.csv') && file.size > 1_000_000)
        throw new Error('Choose a CSV under 1 MB in this workspace.');
      const result = await convertFile(file);
      if (result.sheets.length > 1) {
        setConversion({ file, result });
        return;
      }
      acceptConversion(file, result, 0);
    } catch (e) {
      if (
        onLargeFile &&
        file.name.toLowerCase().endsWith('.csv') &&
        err(e).includes('5,000')
      ) {
        onLargeFile(file);
        return;
      }
      setError(err(e));
    }
  }
  function acceptConversion(file: File, result: ConvertedFile, index: number) {
    const csv = result.sheets[index].csv;
    if (!csv)
      throw new Error(
        'This sheet exceeds the conversion limits. Export it as CSV for the large-file workspace.',
      );
    parseCSV(csv); // Validate before reset so errors do not get swallowed.
    reset(csv, file.name.replace(/\.(xlsx|xls|json)$/i, '.csv'), false);
    setSourceFile(file);
    setConversionWarnings(result.warnings);
    setConversion(null);
  }
  function chooseFinding(id: string) {
    setSelectedId(id);
    setNote('');
    setManual('');
  }
  function openChecks() {
    setDraft(rules);
    setError('');
    setRuleOpen(true);
  }
  const complete = ran && pending.length === 0;
  const doneCount = combined.length - pending.length;
  const checkCount = activeChecks.filter((c) =>
    traces.some((t) => t.tool === c),
  ).length;
  const currentStep = !hasFile ? 1 : complete ? 3 : 2;
  const exportName = original.name.replace(/\.csv$/i, '') + '-updated.csv';
  return (
    <main className="shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <ScanSearch />
          </span>
          <span>
            Cleanroom Detective<small>A clearer view of your spreadsheet</small>
          </span>
        </div>
        {onOpenLarge && (
          <Button variant="ghost" onClick={onOpenLarge}>
            <FileSpreadsheet size={18} /> Large-file workspace
          </Button>
        )}
        <Button
          variant="ghost"
          className="help-button"
          onClick={() => setHelpOpen(true)}
        >
          <CircleHelp size={18} /> Quick guide
        </Button>
      </header>
      <div className="journey" aria-label="Your progress">
        {['Add your file', 'Check & review', 'Download'].map((step, i) => (
          <div
            className={`${currentStep === i + 1 ? 'current' : ''} ${currentStep > i + 1 ? 'done' : ''}`}
            key={step}
            aria-current={currentStep === i + 1 ? 'step' : undefined}
          >
            <span>{currentStep > i + 1 ? <CheckIcon size={14} /> : i + 1}</span>
            <b>{step}</b>
          </div>
        ))}
      </div>
      <input
        ref={uploadRef}
        type="file"
        accept=".csv,.xlsx,.xls,.json,text/csv,application/json"
        hidden
        onChange={(e) => {
          void loadFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error && (
        <div className="global-message error-banner" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss message"
            onClick={() => setError('')}
          >
            <X />
          </Button>
        </div>
      )}
      {!hasFile ? (
        <Welcome
          largeFiles={!!onOpenLarge}
          onChoose={() => uploadRef.current?.click()}
          onExample={() => reset()}
          onDrop={(f) => {
            void loadFile(f);
          }}
        />
      ) : (
        <div className="review-workspace">
          <div className="file-ribbon">
            <span className="file-badge">
              <FileSpreadsheet />
            </span>
            <div>
              <strong>{original.name}</strong>
              <span>
                {data.rows.length.toLocaleString()} rows <i>·</i>{' '}
                {data.headers.length} columns{' '}
                {original.original === SAMPLE_CSV && <em>Example file</em>}
              </span>
            </div>
            <div className="file-actions">
              {!!decisions.length && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => setExportOpen(true)}
                >
                  <Download size={15} /> Download
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => uploadRef.current?.click()}
              >
                Change file
              </Button>
            </div>
          </div>
          {notice && (
            <div className="decision-message">
              <output>
                <CheckCircle2 size={17} />
                {notice}
              </output>
              {decisions.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={undo}
                >
                  <RotateCcw size={14} /> Undo
                </Button>
              )}
            </div>
          )}
          {!ran && !busy ? (
            <section className="ready-card">
              <div className="ready-copy">
                <span className="soft-icon">
                  <ListChecks size={26} />
                </span>
                <p className="eyebrow">Your file is ready</p>
                <h1>Let’s see what needs a little attention.</h1>
                <p>
                  We’ll look for possible problems and explain what we find.
                  You’ll choose which changes to keep.
                </p>
                {!!conversionWarnings.length && (
                  <div className="conversion-note">
                    {conversionWarnings.map((w) => (
                      <p key={w}>{w}</p>
                    ))}
                  </div>
                )}
                <div className="check-chips">
                  {activeChecks.map((c) => (
                    <span key={c}>
                      <CheckIcon size={13} />
                      {CHECK_LABELS[c]}
                    </span>
                  ))}
                </div>
                {!activeChecks.length && (
                  <p className="setting-help">
                    We couldn’t match the column names automatically. Choose the
                    columns you want us to check.
                  </p>
                )}
                <div className="ready-actions">
                  <Button
                    className="primary-large"
                    disabled={!!answerKey.length}
                    onClick={() =>
                      activeChecks.length
                        ? void investigate(model.configured ? 'ai' : 'rules')
                        : openChecks()
                    }
                  >
                    {activeChecks.length ? <ScanSearch /> : <Settings2 />}
                    {activeChecks.length
                      ? 'Check my file'
                      : 'Choose columns to check'}
                    <ArrowRight size={17} />
                  </Button>
                  {!!activeChecks.length && (
                    <Button
                      variant="ghost"
                      disabled={!!answerKey.length}
                      onClick={openChecks}
                    >
                      <SlidersHorizontal size={17} /> Set goal & adjust checks
                    </Button>
                  )}
                </div>
                {model.configured && !!activeChecks.length && (
                  <Button
                    variant="ghost"
                    className="standard-checks"
                    disabled={!!answerKey.length}
                    onClick={() => void investigate('rules')}
                  >
                    Use standard checks without AI
                  </Button>
                )}
                <span className="trust-line">
                  <ShieldCheck size={15} /> Your original file won’t be changed.
                </span>
              </div>
              <div className="ready-preview">
                <div className="preview-caption">
                  <Table2 size={16} /> A peek at your file
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      {data.headers.slice(0, 3).map((h) => (
                        <TableHead key={h}>
                          {h}
                          <small>
                            {profile(data, rules).columns.find(
                              (c) => c.name === h,
                            )?.numeric === data.rows.length
                              ? 'Numeric'
                              : 'Text / mixed'}
                          </small>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.slice(0, 4).map((row) => (
                      <TableRow key={row.id}>
                        {row.cells.slice(0, 3).map((c, i) => (
                          <TableCell key={i}>{c || '—'}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <small>
                  {original.original === SAMPLE_CSV
                    ? 'The example includes a few intentional mistakes.'
                    : 'We’ll check every row, not just this preview.'}
                </small>
              </div>
            </section>
          ) : busy ? (
            <section className="checking-card" aria-live="polite">
              <div className="checking-symbol">
                <ScanSearch size={30} />
              </div>
              <p className="eyebrow">One step at a time</p>
              <h1>Taking a closer look…</h1>
              <p>Your file is unchanged while we check it.</p>
              <Progress
                value={
                  activeChecks.length
                    ? (checkCount / activeChecks.length) * 100
                    : 0
                }
                aria-label="Checks completed"
              />
              <small>
                {checkCount} of {activeChecks.length} checks complete
              </small>
              <p className="checking-detail">{status}</p>
              <Button variant="ghost" onClick={() => abortRef.current?.abort()}>
                Stop checking
              </Button>
            </section>
          ) : (
            <>
              <div className="results-heading">
                <div>
                  <p className="eyebrow">
                    {complete
                      ? 'You’re ready for the next step'
                      : 'Let’s take a look together'}
                  </p>
                  <h1>
                    {complete
                      ? 'Your review is complete.'
                      : 'A few things to look at.'}
                  </h1>
                  <p>
                    {complete
                      ? `${applied} change${applied === 1 ? '' : 's'} applied. ${decisions.filter((d) => d.action === 'keep').length} item${decisions.filter((d) => d.action === 'keep').length === 1 ? '' : 's'} kept as they were.`
                      : `${pending.filter((f) => f.kind === 'repair').length} suggested fixes and ${pending.filter((f) => f.kind !== 'repair').length} things that need your judgment.`}
                  </p>
                </div>
                <Button
                  className="download-top"
                  onClick={() => setExportOpen(true)}
                >
                  <Download /> Download results
                </Button>
              </div>
              <div className="review-progress">
                <div>
                  <span>
                    {doneCount} of {combined.length} items reviewed
                  </span>
                  <span>
                    <ShieldCheck size={14} /> You’re in control
                  </span>
                </div>
                <Progress
                  value={
                    combined.length ? (doneCount / combined.length) * 100 : 100
                  }
                  aria-label="Review progress"
                />
              </div>
              <Tabs
                value={tab}
                onValueChange={(v) => setTab(String(v))}
                className="work-tabs"
              >
                <div className="review-navigation">
                  <TabsList variant="line">
                    <TabsTrigger value="findings">
                      <ListChecks /> Review
                      {pending.length > 0 && (
                        <span className="tabcount">{pending.length}</span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="dataset">
                      <Table2 /> Your data
                    </TabsTrigger>
                    <TabsTrigger value="ledger">
                      <History /> Changes
                    </TabsTrigger>
                    <TabsTrigger value="trace">
                      <Info /> Details
                    </TabsTrigger>
                  </TabsList>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!answerKey.length}
                    onClick={openChecks}
                  >
                    <SlidersHorizontal /> Check settings
                  </Button>
                </div>
                <TabsContent value="findings">
                  {complete && filter === 'pending' ? (
                    <section className="finished-card">
                      <div className="finish-symbol">
                        <CheckIcon size={32} />
                      </div>
                      <h2>
                        {combined.length
                          ? 'All decisions saved.'
                          : 'No issues found in these checks.'}
                      </h2>
                      <p>
                        {combined.length
                          ? 'Your updated file contains only the changes you approved.'
                          : 'The checks you selected did not flag any rows. You can add more checks or download a copy.'}
                        {decisions.some((d) => d.action === 'keep') &&
                          ' Items you kept unchanged still appear in the detailed report.'}
                      </p>
                      <Button
                        className="primary-large"
                        onClick={() => download(exportName, toCSV(data))}
                      >
                        <Download /> Download updated CSV
                      </Button>
                      <div className="finished-links">
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setFilter('all');
                            setSelectedId('');
                          }}
                        >
                          View reviewed items
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => setExportOpen(true)}
                        >
                          Report & other files <ArrowRight size={15} />
                        </Button>
                      </div>
                      {decisions.length > 0 && (
                        <Button variant="ghost" size="sm" onClick={undo}>
                          <RotateCcw size={15} /> Undo last decision
                        </Button>
                      )}
                    </section>
                  ) : (
                    <div className="review-grid">
                      <aside className="suggestions">
                        <div className="suggestion-tools">
                          <Select
                            value={filter}
                            onValueChange={(v) => {
                              setFilter(String(v));
                              setSelectedId('');
                              setNote('');
                              setManual('');
                            }}
                          >
                            <SelectTrigger aria-label="Which suggestions to show">
                              <SelectValue>
                                {filter === 'pending'
                                  ? 'To review'
                                  : filter === 'repair'
                                    ? 'Suggested fixes'
                                    : filter === 'review'
                                      ? 'Needs a closer look'
                                      : 'All items'}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="pending">To review</SelectItem>
                              <SelectItem value="repair">
                                Suggested fixes
                              </SelectItem>
                              <SelectItem value="review">
                                Needs a closer look
                              </SelectItem>
                              <SelectItem value="all">All items</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="searchfield">
                            <Search size={16} />
                            <Input
                              aria-label="Search suggestions"
                              placeholder="Find a row or column…"
                              value={search}
                              onChange={(e) => {
                                setSearch(e.target.value);
                                setSelectedId('');
                                setNote('');
                                setManual('');
                              }}
                            />
                          </div>
                        </div>
                        <div className="suggestion-list">
                          {visible.map((f) => {
                            const d = decisions.find(
                              (d) => d.finding.id === f.id,
                            );
                            return (
                              <button
                                key={f.id}
                                onClick={() => chooseFinding(f.id)}
                                aria-pressed={selected?.id === f.id}
                                className={`suggestion-row ${selected?.id === f.id ? 'selected' : ''}`}
                              >
                                <span
                                  className={`suggestion-dot ${d ? 'reviewed' : f.patch ? 'fix' : 'look'}`}
                                >
                                  {d ? (
                                    <CheckIcon size={15} />
                                  ) : f.patch ? (
                                    <Settings2 size={14} />
                                  ) : (
                                    <CircleHelp size={15} />
                                  )}
                                </span>
                                <span>
                                  <small>
                                    Row {f.rowId} · {f.column}
                                  </small>
                                  <strong>{friendlyTitle(f)}</strong>
                                  <em>
                                    {d
                                      ? d.action === 'apply'
                                        ? 'Updated'
                                        : 'Kept as is'
                                      : label(f)}
                                  </em>
                                </span>
                                <ChevronRight size={16} />
                              </button>
                            );
                          })}
                          {!visible.length && (
                            <div className="list-empty">
                              <Search />
                              <p>No matching items.</p>
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  setSearch('');
                                  setFilter('all');
                                }}
                              >
                                Show all items
                              </Button>
                            </div>
                          )}
                        </div>
                      </aside>
                      <section
                        className="suggestion-detail"
                        aria-label="Selected suggestion"
                      >
                        {selected ? (
                          <>
                            <div className="detail-top">
                              <span
                                className={`kind-label ${selected.patch ? 'fix' : 'look'}`}
                              >
                                {decision ? 'Reviewed' : label(selected)}
                              </span>
                              <span>
                                Row {selected.rowId} <i>·</i> {selected.column}
                              </span>
                            </div>
                            <h2 aria-live="polite" aria-atomic="true">
                              {friendlyTitle(selected)}
                            </h2>
                            <p className="detail-description">
                              {selected.detail}
                            </p>
                            {selected.patch ? (
                              <div className="before-after">
                                {selected.patch.deleteRow ? (
                                  <>
                                    <div>
                                      <span>
                                        {decision?.action === 'apply'
                                          ? 'Before'
                                          : 'Now'}
                                      </span>
                                      <strong>Two identical rows</strong>
                                      <small>Same ID and the same values</small>
                                    </div>
                                    <ArrowRight />
                                    <div className="after-value">
                                      <span>
                                        {decision?.action === 'apply'
                                          ? 'After your change'
                                          : 'After your approval'}
                                      </span>
                                      <strong>Keep one copy</strong>
                                      <small>
                                        {decision?.action === 'apply'
                                          ? 'Removed'
                                          : 'Remove'}{' '}
                                        extra row {selected.rowId}
                                      </small>
                                    </div>
                                  </>
                                ) : (
                                  selected.patch.changes.map((c) => (
                                    <div
                                      className="value-change"
                                      key={c.column}
                                    >
                                      <div>
                                        <span>
                                          {data.headers[c.column]} ·{' '}
                                          {decision?.action === 'apply'
                                            ? 'before'
                                            : 'now'}
                                        </span>
                                        <strong>{c.before || '(empty)'}</strong>
                                      </div>
                                      <ArrowRight />
                                      <div className="after-value">
                                        <span>
                                          {decision?.action === 'apply'
                                            ? 'Applied value'
                                            : 'Suggested value'}
                                        </span>
                                        <strong>{c.after}</strong>
                                      </div>
                                    </div>
                                  ))
                                )}
                              </div>
                            ) : (
                              <div className="review-callout">
                                <CircleHelp size={22} />
                                <div>
                                  <strong>This one needs your judgment.</strong>
                                  <p>
                                    {selected.check === 'outliers'
                                      ? 'Unusual doesn’t always mean incorrect. Keep it if it matches your records.'
                                      : 'We can show what looks unusual, but the correct value needs to come from your source.'}
                                  </p>
                                </div>
                              </div>
                            )}
                            <p className="finding-priority">
                              {findingMeta(selected).severity} priority ·{' '}
                              {findingMeta(selected).confidence}
                            </p>
                            <Accordion
                              className="evidence-accordion"
                              defaultValue={[]}
                            >
                              <AccordionItem value="evidence">
                                <AccordionTrigger>
                                  Why{' '}
                                  {selected.patch
                                    ? 'this suggestion'
                                    : 'was this flagged'}
                                  ?
                                </AccordionTrigger>
                                <AccordionContent>
                                  <ol>
                                    {selected.evidence.map((e, i) => (
                                      <li key={i}>{e}</li>
                                    ))}
                                  </ol>
                                </AccordionContent>
                              </AccordionItem>
                            </Accordion>
                            {decision ? (
                              <div className="saved-decision">
                                <CheckCircle2 size={20} />
                                <div>
                                  <strong>
                                    {decision.action === 'apply'
                                      ? 'Change applied'
                                      : 'Kept as is'}
                                  </strong>
                                  <p>
                                    {decision.note ||
                                      'You approved this suggestion.'}
                                  </p>
                                </div>
                                {decisions.at(-1)?.id === decision.id && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={undo}
                                  >
                                    Undo
                                  </Button>
                                )}
                              </div>
                            ) : (
                              <div className="review-actions">
                                <label
                                  className="field note-field"
                                  htmlFor="review-note"
                                >
                                  Add a note <span>(optional)</span>
                                  <Textarea
                                    id="review-note"
                                    value={note}
                                    onChange={(e) => setNote(e.target.value)}
                                    placeholder="Anything you’d like to remember about this decision…"
                                    rows={2}
                                  />
                                </label>
                                <div className="decision-buttons">
                                  {selected.patch && (
                                    <Button
                                      className="primary-large"
                                      onClick={() => decide('apply')}
                                    >
                                      <CheckIcon /> Apply this fix
                                    </Button>
                                  )}
                                  <Button
                                    className={
                                      selected.patch
                                        ? 'keep-button'
                                        : 'primary-large'
                                    }
                                    variant={
                                      selected.patch ? 'outline' : 'default'
                                    }
                                    onClick={() => decide('keep')}
                                  >
                                    Keep as is
                                    {!selected.patch?.deleteRow && (
                                      <ArrowRight size={16} />
                                    )}
                                  </Button>
                                </div>
                                {similar.length > 1 && (
                                  <Button
                                    variant="outline"
                                    onClick={() => setBulkOpen(true)}
                                  >
                                    Preview {similar.length} similar fixes
                                  </Button>
                                )}
                                <p className="undo-hint">
                                  <RotateCcw size={13} /> You can undo a
                                  decision at any time in Changes.
                                </p>
                                {!selected.patch && (
                                  <Accordion className="manual-accordion">
                                    <AccordionItem value="manual">
                                      <AccordionTrigger>
                                        I know the correct value
                                      </AccordionTrigger>
                                      <AccordionContent>
                                        <p>
                                          Use a value you verified against your
                                          source. Add the source to your note
                                          above.
                                        </p>
                                        <label
                                          className="field"
                                          htmlFor="manual-value"
                                        >
                                          Correct value
                                          <Input
                                            id="manual-value"
                                            value={manual}
                                            onChange={(e) =>
                                              setManual(e.target.value)
                                            }
                                            placeholder="Enter the value from your source"
                                          />
                                        </label>
                                        <Button
                                          variant="outline"
                                          onClick={() => decide('apply', true)}
                                        >
                                          Save my correction
                                        </Button>
                                      </AccordionContent>
                                    </AccordionItem>
                                  </Accordion>
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="empty-detail">
                            <CheckCircle2 />
                            <h2>Choose an item to take a closer look.</h2>
                          </div>
                        )}
                      </section>
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="dataset">
                  <section className="data-card">
                    <div className="panelhead">
                      <div>
                        <h2>Your updated spreadsheet</h2>
                        <p>Changes you approved are highlighted.</p>
                      </div>
                      <span className="quiet-tag">{data.rows.length} rows</span>
                    </div>
                    <div className="dataset-scroll">
                      <Table className="data-table">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Row</TableHead>
                            {data.headers.map((h) => (
                              <TableHead key={h}>{h}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.rows.slice(0, 200).map((r) => (
                            <TableRow key={r.id}>
                              <TableCell className="rownum">{r.id}</TableCell>
                              {r.cells.map((c, i) => (
                                <TableCell
                                  key={i}
                                  className={
                                    original.rows.find((o) => o.id === r.id)
                                      ?.cells[i] !== c
                                      ? 'changed-cell'
                                      : ''
                                  }
                                >
                                  {c || (
                                    <span className="missing-cell">empty</span>
                                  )}
                                </TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="table-note">
                      Row numbers refer to the original file, without its
                      header.{' '}
                      {data.rows.length > 200
                        ? 'Showing 200 rows; all rows were checked.'
                        : ''}
                    </p>
                  </section>
                </TabsContent>
                <TabsContent value="ledger">
                  <section className="data-card">
                    <div className="panelhead">
                      <div>
                        <h2>Your decisions</h2>
                        <p>
                          {applied} updates ·{' '}
                          {decisions.filter((d) => d.action === 'keep').length}{' '}
                          kept as is
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={!decisions.length}
                        onClick={undo}
                      >
                        <RotateCcw /> Undo last decision
                      </Button>
                    </div>
                    {decisions.length ? (
                      <div className="ledger-list">
                        {decisions.map((d) => (
                          <article key={d.id}>
                            <span className="ledger-icon">
                              <CheckIcon size={18} />
                            </span>
                            <div>
                              <small>
                                Row {d.finding.rowId} · {d.finding.column}
                              </small>
                              <h3>{friendlyTitle(d.finding)}</h3>
                              <p>{d.note || 'You approved this change.'}</p>
                            </div>
                            <span className="quiet-tag">
                              {d.action === 'apply' ? 'Updated' : 'Kept as is'}
                            </span>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-detail">
                        <History />
                        <h2>Your changes will appear here.</h2>
                        <p>
                          Review a suggestion to get started. Your original
                          stays unchanged.
                        </p>
                        <Button onClick={() => setTab('findings')}>
                          Review suggestions <ArrowRight size={16} />
                        </Button>
                      </div>
                    )}
                  </section>
                </TabsContent>
                <TabsContent value="trace">
                  <section className="data-card details-card">
                    <div className="panelhead">
                      <div>
                        <h2>Behind the check</h2>
                        <p>A record of what ran and what it found.</p>
                      </div>
                      <span className="quiet-tag">
                        {traces.some((t) => t.tool === 'model_choose_check')
                          ? 'AI-assisted check'
                          : 'Rules-based check'}
                      </span>
                    </div>
                    <div className="details-body">
                      <p>{summary}</p>
                      <div className="detail-tools">
                        <Button
                          variant="outline"
                          disabled={!!answerKey.length}
                          onClick={() =>
                            investigate(model.configured ? 'ai' : 'rules')
                          }
                        >
                          <RotateCcw /> Check file again
                        </Button>
                        {model.configured && (
                          <Button
                            variant="outline"
                            disabled={!!answerKey.length}
                            onClick={() => investigate('rules')}
                          >
                            Compare with rules only
                          </Button>
                        )}
                      </div>
                      <Accordion>
                        <AccordionItem value="checks">
                          <AccordionTrigger>
                            View check history
                          </AccordionTrigger>
                          <AccordionContent>
                            <ol className="trace-list">
                              {traces.map((t, i) => (
                                <li key={i}>
                                  <span className="trace-number">{i + 1}</span>
                                  <div>
                                    <strong>
                                      {CHECK_LABELS[t.tool as Check] ||
                                        t.tool.replaceAll('_', ' ')}
                                    </strong>
                                    <p>{t.summary}</p>
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </AccordionContent>
                        </AccordionItem>
                        <AccordionItem value="technical">
                          <AccordionTrigger>Advanced details</AccordionTrigger>
                          <AccordionContent>
                            <p>
                              {model.configured
                                ? `Available AI connection: ${model.provider} · ${model.model}`
                                : 'This version runs the checks in your browser without a language model.'}
                            </p>
                            <p>
                              For an independent evaluation, reveal a
                              human-prepared answer key after the first check.
                              This is optional and isn’t needed to tidy your
                              file.
                            </p>
                            <Button
                              variant="outline"
                              onClick={() => setKeyOpen(true)}
                            >
                              <FlaskConical /> Compare an answer key
                            </Button>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    </div>
                  </section>
                </TabsContent>
              </Tabs>
              <div className="workspace-foot">
                <span>
                  <ShieldCheck size={15} /> Your original stays unchanged.
                </span>
                <span>Download your results before closing this tab.</span>
              </div>
            </>
          )}
        </div>
      )}
      <footer className="app-footer">
        <span>Small fixes. Clear explanations. Your call.</span>
        <span>
          {STATIC_DEMO
            ? 'Your CSV stays in your browser.'
            : 'Changes only happen with your approval.'}
        </span>
      </footer>
      <CheckSettings
        open={ruleOpen}
        onOpenChange={setRuleOpen}
        headers={data.headers}
        draft={draft}
        setDraft={setDraft}
        onSave={saveRules}
        error={error}
      />
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="export-dialog">
          <DialogHeader>
            <DialogTitle>Ready to take your file with you?</DialogTitle>
            <DialogDescription>
              {pending.length
                ? `${pending.length} item${pending.length === 1 ? ' is' : 's are'} still waiting for review. Your download includes only the changes you approved.`
                : 'Your updated copy includes the changes you approved. The original is unchanged.'}
            </DialogDescription>
          </DialogHeader>
          <Button
            className="export-main"
            onClick={() => download(exportName, toCSV(data))}
          >
            <Download size={24} />
            <span>
              <strong>Download updated CSV</strong>
              <small>
                {data.rows.length} rows · {applied} approved changes
              </small>
            </span>
            <ArrowRight />
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              try {
                printReport(
                  reportHTML(original, data, rules, decisions, traces, summary),
                );
              } catch (e) {
                setError(err(e));
              }
            }}
          >
            <Download /> Save report as PDF
          </Button>
          <p className="setting-help">
            Opens a print-ready report. Choose “Save as PDF” in your browser’s
            print dialog.
          </p>
          <Button
            variant="ghost"
            onClick={() =>
              download(
                'unresolved-issues.csv',
                unresolvedCSV(findings, decisions),
              )
            }
          >
            Download unresolved issues (including kept values)
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              if (sourceFile) {
                const url = URL.createObjectURL(sourceFile);
                const a = document.createElement('a');
                a.href = url;
                a.download = sourceFile.name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } else download(original.name, original.original);
            }}
          >
            Download original file
          </Button>
          <p className="export-more-label">Need the details, too?</p>
          {[
            [
              'Review report',
              'Suggestions, decisions, and explanations',
              'review-report.html',
              () =>
                reportHTML(original, data, rules, decisions, traces, summary),
              'text/html',
            ],
            [
              'List of changes',
              'Before and after values with your notes',
              'changes.csv',
              () => ledgerCSV(original, decisions),
              'text/csv',
            ],
          ].map(([title, description, name, body, mime]) => (
            <Button
              key={String(title)}
              variant="ghost"
              className="export-secondary"
              onClick={() =>
                download(String(name), (body as () => string)(), String(mime))
              }
            >
              <FileSpreadsheet />
              <span>
                <strong>{String(title)}</strong>
                <small>{String(description)}</small>
              </span>
              <Download size={16} />
            </Button>
          ))}
        </DialogContent>
      </Dialog>
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>Review these {similar.length} changes</DialogTitle>
            <DialogDescription>
              Each correction is calculated from its own row. Only the fixes
              listed here will be applied. Undo restores this whole batch.
            </DialogDescription>
          </DialogHeader>
          <div className="bulk-preview">
            {similar.map((f) => (
              <p key={f.id}>
                <b>Row {f.rowId}</b> ·{' '}
                {f.patch?.changes
                  .map(
                    (c) =>
                      `${data.headers[c.column]}: ${c.before || '(empty)'} → ${c.after}`,
                  )
                  .join('; ')}
              </p>
            ))}
          </div>
          <Button onClick={applySimilar}>
            Approve these {similar.length} changes
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!conversion}
        onOpenChange={(v) => {
          if (!v) setConversion(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose a worksheet</DialogTitle>
            <DialogDescription>
              Your original workbook stays unchanged. Each sheet is checked
              separately.
            </DialogDescription>
          </DialogHeader>
          {conversion?.result.sheets.map((sheet, index) => (
            <Button
              key={sheet.name}
              variant="outline"
              disabled={!sheet.csv}
              onClick={() => {
                try {
                  acceptConversion(conversion.file, conversion.result, index);
                } catch (e) {
                  setError(err(e));
                }
              }}
            >
              {sheet.name}
              {!sheet.csv ? ' · export this sheet as CSV' : ''}
            </Button>
          ))}
          {error && <p role="alert">{error}</p>}
        </DialogContent>
      </Dialog>
      <Dialog open={keyOpen} onOpenChange={setKeyOpen}>
        <DialogContent className="wide-dialog">
          <DialogHeader>
            <DialogTitle>Compare an answer key</DialogTitle>
            <DialogDescription>
              This optional evaluation compares a human-prepared key with the
              first completed check. Revealing it locks further checks for this
              file.
            </DialogDescription>
          </DialogHeader>
          <p className="setting-help">
            CSV columns: <code>row,check,truth</code>. Row is the original
            record number, without the header. Truth is <code>defect</code> or{' '}
            <code>valid</code>. Supported checks: {CHECKS.join(', ')}. The
            included example isn’t a blind benchmark.
          </p>
          <input
            ref={keyRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void revealKey(f);
              e.target.value = '';
            }}
          />
          {!answerKey.length ? (
            <Button onClick={() => keyRef.current?.click()}>
              <Upload /> Reveal answer key
            </Button>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {['Row', 'Check', 'Expected', 'Observed'].map((h) => (
                    <TableHead key={h}>{h}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {scoreAnswerKey(answerKey, frozen).map((k) => (
                  <TableRow key={`${k.row}:${k.check}`}>
                    <TableCell>{k.row}</TableCell>
                    <TableCell>{k.check}</TableCell>
                    <TableCell>{k.truth}</TableCell>
                    <TableCell>{k.result}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {error && <p className="error-text">{error}</p>}
        </DialogContent>
      </Dialog>
      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="guide-dialog">
          <DialogHeader>
            <DialogTitle>A clearer spreadsheet in three steps</DialogTitle>
            <DialogDescription>
              You don’t need to be a data expert. We’ll explain each suggestion
              as you go.
            </DialogDescription>
          </DialogHeader>
          <ol className="help-list">
            <li>
              <span>1</span>
              <div>
                <b>Add your file</b>
                <p>
                  Choose CSV, Excel, or a flat JSON table, or try the café
                  example. Large CSVs open in the browser workspace.
                </p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <b>Check it, then review</b>
                <p>
                  We’ll show possible fixes, along with before and after values.
                  Apply a fix or keep things as they are. Use “Why this
                  suggestion?” to see the evidence.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <b>Download your updated copy</b>
                <p>
                  You can undo decisions in Changes. When you’re ready, download
                  your CSV and an optional report.
                </p>
              </div>
            </li>
          </ol>
          <div className="guide-note">
            <ShieldCheck size={20} />
            <p>
              Your original file is always kept unchanged. Download your work
              before you close or refresh the tab.
            </p>
          </div>
          <p className="guide-links">
            <a
              href={publicAsset('cleanroom-detective-explainer.pdf')}
              target="_blank"
              rel="noreferrer"
            >
              Visual explanation (PDF)
            </a>
            <a href={publicAsset('cleanroom-detective-explainer.tex')} download>
              LaTeX source
            </a>
          </p>
          <small className="mode-note">
            {STATIC_DEMO
              ? 'This shared version runs rule-based checks entirely in your browser.'
              : 'When connected, AI chooses the checks. The checks supply the evidence; you decide what changes.'}
          </small>
        </DialogContent>
      </Dialog>
    </main>
  );
}
