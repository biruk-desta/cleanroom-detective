'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ScanSearch,
  FileSpreadsheet,
  Upload,
  Play,
  ShieldCheck,
  Check as CheckIcon,
  ArrowRight,
  Download,
  Settings2,
  RotateCcw,
  Search,
  CircleHelp,
  LoaderCircle,
  CheckCircle2,
  AlertCircle,
  X,
  FlaskConical,
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
import { Checkbox } from '@/components/ui/checkbox';
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
} from '@/lib/audit';
import { reportHTML } from '@/lib/report';
import { STATIC_DEMO, publicAsset } from '@/lib/runtime';
const INITIAL = parseCSV(SAMPLE_CSV, 'cafe-sales-practice.csv');
const label = (f: Finding) =>
  f.kind === 'repair'
    ? 'Supported repair'
    : f.kind === 'issue'
      ? 'Source needed'
      : 'Human review';
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
function MapField({
  label,
  value,
  headers,
  onChange,
}: {
  label: string;
  value: string;
  headers: string[];
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      {label}
      <Select
        value={value || '__none'}
        onValueChange={(v) => onChange(v === '__none' ? '' : String(v))}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">Not mapped</SelectItem>
          {headers.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
function Toggle({
  text,
  value,
  onChange,
}: {
  text: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="rule-toggle">
      <Checkbox checked={value} onCheckedChange={(v) => onChange(v === true)} />
      <span>{text}</span>
    </label>
  );
}
export default function Home() {
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
    [filter, setFilter] = useState('all'),
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
    return [...m.values()].sort((a, b) => a.rowId - b.rowId);
  }, [findings, decisions]);
  const pending = combined.filter(
    (f) => !decisions.some((d) => d.finding.id === f.id),
  );
  const visible = combined.filter(
    (f) =>
      (filter === 'all' ||
        (filter === 'repair' ? f.kind === 'repair' : f.kind !== 'repair')) &&
      `${f.rowId} ${f.title} ${f.column}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const selected = combined.find((f) => f.id === selectedId) ?? visible[0],
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
      setOriginal(next);
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
      setFilter('all');
      setTab('findings');
      setRuleOpen(!sample);
      setNotice(
        sample
          ? 'Practice case reset. This is a synthetic teaching dataset.'
          : 'CSV loaded. Confirm the data rules before investigating.',
      );
    } catch (e) {
      setError(err(e));
    }
  }
  function saveRules() {
    try {
      validateRules(draft, data.headers);
      setRules(draft);
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
        setSelectedId(fs[0]?.id ?? '');
        setRan(true);
        setSummary(
          'Rules audit completed. Every configured check ran; no language model was used.',
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
            setSelectedId(e.findings[0]?.id ?? '');
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
      setError(err(e));
      setStatus('Investigation incomplete');
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
      if (action === 'keep' && !note.trim())
        throw new Error('Add a short reason for keeping this value.');
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
          note: note.trim(),
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
      setNotice(
        action === 'apply'
          ? 'Repair applied to the working copy. All configured checks ran again.'
          : 'Decision recorded. The original value remains.',
      );
      setError('');
    } catch (e) {
      setError(err(e));
    }
  }
  function undo() {
    try {
      const next = decisions.slice(0, -1);
      setFindings(allFindings(materialize(original, next), rules));
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
  const setDraftField = <K extends keyof Rules>(key: K, value: Rules[K]) =>
    setDraft((r) => ({ ...r, [key]: value }));
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <ScanSearch />
          <div>
            Cleanroom Detective<small>Data investigation workspace</small>
          </div>
        </div>
        <div className="topmeta">
          <ShieldCheck size={18} /> Original preserved · Every change explained
        </div>
        <Button
          variant="ghost"
          className="tophelp"
          onClick={() => setHelpOpen(true)}
        >
          <CircleHelp /> How it works
        </Button>
      </header>
      <div className="workspace">
        <div className="caseheading">
          <div>
            <p className="eyebrow">
              Case 001 /{' '}
              {original.original === SAMPLE_CSV
                ? 'Synthetic practice dataset'
                : 'Your dataset'}
            </p>
            <h1>{original.name}</h1>
            <p className="case-subtitle">
              {original.rows.length} source records · {original.headers.length}{' '}
              columns · {applied} approved repairs
            </p>
          </div>
          <div className="actions">
            <input
              ref={uploadRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) {
                  if (f.size > 1_000_000)
                    setError('Use a CSV smaller than 1 MB.');
                  else reset(await f.text(), f.name, false);
                }
                e.target.value = '';
              }}
            />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => uploadRef.current?.click()}
            >
              <Upload /> Upload CSV
            </Button>
            <Button
              variant="outline"
              disabled={busy || !!answerKey.length}
              onClick={() => {
                setDraft(rules);
                setError('');
                setRuleOpen(true);
              }}
            >
              <Settings2 /> Data rules
            </Button>
            <Button
              variant="outline"
              disabled={!ran || busy}
              onClick={() => setExportOpen(true)}
            >
              <Download /> Export
            </Button>
            <Button
              disabled={busy || !!answerKey.length}
              onClick={() => investigate(model.configured ? 'ai' : 'rules')}
            >
              {busy ? <LoaderCircle className="spin" /> : <Play />}
              {busy
                ? 'Investigating…'
                : model.configured
                  ? 'Start AI investigation'
                  : 'Run rules audit'}
            </Button>
          </div>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss error"
              onClick={() => setError('')}
            >
              <X />
            </Button>
          </div>
        )}
        {notice && (
          <output className="toast-inline">
            <CheckCircle2 size={17} />
            {notice}
          </output>
        )}
        <div className="workgrid">
          <aside className="panel sidepanel">
            <div className="panelbody">
              <div className="fileicon">
                <FileSpreadsheet />
              </div>
              <h2>Case file</h2>
              <p className="explain">
                A clear trail from question to evidence.
              </p>
              <div className="stats">
                <div className="stat">
                  <strong>{data.rows.length}</strong>
                  <span>working records</span>
                </div>
                <div className="stat">
                  <strong>{activeChecks.length}</strong>
                  <span>active checks</span>
                </div>
              </div>
              <span className="pill good">
                <ShieldCheck size={13} /> Original kept intact
              </span>
              <div className="section-label">
                <h3>Data rules</h3>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Configure data rules"
                  disabled={busy || !!answerKey.length}
                  onClick={() => {
                    setDraft(rules);
                    setError('');
                    setRuleOpen(true);
                  }}
                >
                  <Settings2 />
                </Button>
              </div>
              {activeChecks.map((c) => (
                <div className="side-rule" key={c}>
                  <CheckIcon />
                  {CHECK_NAMES[c]}
                </div>
              ))}
              {!activeChecks.length && (
                <p className="footnote">Configure a check to begin.</p>
              )}
              <p className="footnote">
                Only confirmed rules can support a repair. Uncertainty stays
                visible.
              </p>
              <div className="modelcard">
                <p>
                  <span
                    className={`modeldot ${model.configured ? 'live' : ''}`}
                  />
                  {model.configured
                    ? 'Live AI investigator'
                    : 'Rules audit available'}
                </p>
                <small>
                  {model.configured
                    ? `${model.provider} · ${model.model}`
                    : STATIC_DEMO
                      ? 'Runs entirely in your browser. Upload a CSV or try the practice case. No sign-in needed.'
                      : 'The hosted app has no model key configured. Checks and review still work.'}
                </small>
                {model.configured && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !!answerKey.length}
                    onClick={() => investigate('rules')}
                  >
                    Run rules comparison
                  </Button>
                )}
              </div>
              <div className="sidebar-bottom">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => reset()}
                >
                  <RotateCcw /> Reset practice case
                </Button>
                <p className="footnote">
                  This session stays in this tab. Export before closing. CSV
                  contents are not stored by this app.
                </p>
              </div>
            </div>
          </aside>
          <section className="maincolumn">
            <div className="metrics">
              <div>
                <span>Needs a decision</span>
                <strong>{ran ? pending.length : '—'}</strong>
              </div>
              <div className="teal">
                <span>Supported repairs</span>
                <strong>
                  {ran
                    ? pending.filter((f) => f.kind === 'repair').length
                    : '—'}
                </strong>
              </div>
              <div className="amber">
                <span>Source / human review</span>
                <strong>
                  {ran
                    ? pending.filter((f) => f.kind !== 'repair').length
                    : '—'}
                </strong>
              </div>
              <div>
                <span>Repairs applied</span>
                <strong>{applied}</strong>
              </div>
            </div>
            <div className="panel">
              <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
                <div className="tabbar">
                  <TabsList variant="line" className="audit-tabs">
                    <TabsTrigger value="findings">
                      Findings{' '}
                      {ran && (
                        <span className="tabcount">{combined.length}</span>
                      )}
                    </TabsTrigger>
                    <TabsTrigger value="dataset">Dataset</TabsTrigger>
                    <TabsTrigger value="trace">Investigation</TabsTrigger>
                    <TabsTrigger value="ledger">Change ledger</TabsTrigger>
                  </TabsList>
                  <span className={`status-indicator ${busy ? 'working' : ''}`}>
                    {busy ? 'Running' : ran ? 'Reviewed checks' : 'Ready'}
                  </span>
                </div>
                <TabsContent value="findings">
                  {busy && (
                    <output className="run-status">
                      <LoaderCircle className="spin" size={18} />
                      {status}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => abortRef.current?.abort()}
                      >
                        Stop
                      </Button>
                    </output>
                  )}
                  {!ran && !busy ? (
                    <div className="empty-state">
                      <div className="empty-symbol">
                        <ScanSearch size={32} />
                      </div>
                      <p className="eyebrow">Follow the evidence</p>
                      <h2>Find the problem. Show the proof.</h2>
                      <p>
                        Inspect a CSV, test its rules, and see exactly why a
                        value deserves attention. You decide what changes.
                      </p>
                      <div className="flow">
                        {[
                          'Profile',
                          'Inspect',
                          'Review & repair',
                          'Re-check',
                        ].map((s, i) => (
                          <span key={s}>
                            <b>{i + 1}</b>
                            {s}
                            {i < 3 && <ArrowRight size={15} />}
                          </span>
                        ))}
                      </div>
                      <Button
                        onClick={() =>
                          investigate(model.configured ? 'ai' : 'rules')
                        }
                      >
                        <Play />
                        {model.configured
                          ? 'Start AI investigation'
                          : 'Run rules audit'}
                      </Button>
                      <small>
                        {original.original === SAMPLE_CSV
                          ? 'Synthetic case: four provable repairs, one impossible date, and one unusual order.'
                          : 'Your file is ready. Confirm its rules, then run the checks.'}
                      </small>
                    </div>
                  ) : (
                    <>
                      <div className="finding-toolbar">
                        <div className="searchfield">
                          <Search size={16} />
                          <Input
                            placeholder="Search findings or record number"
                            aria-label="Search findings"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                          />
                        </div>
                        <Select
                          value={filter}
                          onValueChange={(v) => setFilter(String(v))}
                        >
                          <SelectTrigger aria-label="Filter findings">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">All findings</SelectItem>
                            <SelectItem value="repair">
                              Supported repairs
                            </SelectItem>
                            <SelectItem value="review">Human review</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="finding-grid">
                        <div className="finding-list">
                          {visible.map((f) => {
                            const d = decisions.find(
                              (d) => d.finding.id === f.id,
                            );
                            return (
                              <button
                                key={f.id}
                                className={`finding-item ${selected?.id === f.id ? 'selected' : ''}`}
                                onClick={() => {
                                  setSelectedId(f.id);
                                  setNote('');
                                  setManual('');
                                }}
                              >
                                <div className="finding-meta">
                                  <span>
                                    Record {String(f.rowId).padStart(3, '0')}
                                  </span>
                                  <span
                                    className={`pill ${d ? 'good' : f.kind === 'repair' ? 'good' : 'warn'}`}
                                  >
                                    {d
                                      ? d.action === 'apply'
                                        ? 'Applied'
                                        : 'Kept'
                                      : label(f)}
                                  </span>
                                </div>
                                <strong>{f.title}</strong>
                                <span className="finding-column">
                                  {f.column}
                                </span>
                              </button>
                            );
                          })}
                          {!visible.length && (
                            <div className="empty-evidence">
                              <CheckCircle2 />
                              <p>
                                {busy
                                  ? 'Waiting for measured evidence…'
                                  : 'No findings match this view.'}
                              </p>
                            </div>
                          )}
                        </div>
                        <div className="evidence-panel">
                          {selected ? (
                            <>
                              <div className="detail-intro">
                                <p className="eyebrow">
                                  Record {selected.rowId} / {selected.column}
                                </p>
                                <h2>{selected.title}</h2>
                                <p>{selected.detail}</p>
                              </div>
                              <div className="evidence-box">
                                <h3>Evidence</h3>
                                {selected.evidence.map((e, i) => (
                                  <div className="evidence-line" key={i}>
                                    <b>{i + 1}</b>
                                    <p>{e}</p>
                                  </div>
                                ))}
                              </div>
                              {selected.patch && (
                                <div className="change-preview">
                                  <h3>Proposed change</h3>
                                  {selected.patch.deleteRow ? (
                                    <p>
                                      Remove this extra record. The matching
                                      first record stays.
                                    </p>
                                  ) : (
                                    selected.patch.changes.map((c) => (
                                      <div
                                        className="change-line"
                                        key={c.column}
                                      >
                                        <span>{data.headers[c.column]}</span>
                                        <del>{c.before || '(empty)'}</del>
                                        <ArrowRight size={16} />
                                        <strong>{c.after}</strong>
                                      </div>
                                    ))
                                  )}
                                </div>
                              )}
                              {decision ? (
                                <div className="decision-done">
                                  <CheckCircle2 />
                                  <div>
                                    <strong>
                                      {decision.action === 'apply'
                                        ? 'Applied to working copy'
                                        : 'Kept unchanged'}
                                    </strong>
                                    <p>
                                      {decision.note ||
                                        'Approved the evidence-backed proposal.'}
                                    </p>
                                  </div>
                                </div>
                              ) : (
                                <div className="review-actions">
                                  <label className="field">
                                    Reviewer note{' '}
                                    {selected.patch
                                      ? '(optional for a repair)'
                                      : '/ source evidence'}
                                    <Textarea
                                      value={note}
                                      onChange={(e) => setNote(e.target.value)}
                                      placeholder="Explain your decision or cite the source…"
                                    />
                                  </label>
                                  <div className="actions">
                                    {selected.patch && (
                                      <Button
                                        disabled={busy}
                                        onClick={() => decide('apply')}
                                      >
                                        <CheckIcon /> Apply repair
                                      </Button>
                                    )}
                                    <Button
                                      variant="outline"
                                      disabled={busy}
                                      onClick={() => decide('keep')}
                                    >
                                      Keep unchanged
                                    </Button>
                                  </div>
                                  {!selected.patch && (
                                    <div className="manual-edit">
                                      <label
                                        className="field"
                                        htmlFor="manual-value"
                                      >
                                        Source-verified replacement
                                        <Input
                                          id="manual-value"
                                          value={manual}
                                          onChange={(e) =>
                                            setManual(e.target.value)
                                          }
                                          placeholder="Only if the source proves a correction"
                                        />
                                      </label>
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => decide('apply', true)}
                                      >
                                        Apply source correction
                                      </Button>
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="empty-evidence">
                              <ShieldCheck />
                              <h3>No unsupported edits.</h3>
                              <p>Select a finding to inspect its evidence.</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </TabsContent>
                <TabsContent value="dataset">
                  <div className="panelhead">
                    <h2>Working copy</h2>
                    <span className="pill">{data.rows.length} records</span>
                  </div>
                  <div className="dataset-scroll">
                    <Table className="data-table">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Record</TableHead>
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
                                {c === '' ? (
                                  <span className="missing-cell">empty</span>
                                ) : (
                                  c
                                )}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="footnote panelbody">
                    Stable record numbers refer to parsed source records,
                    excluding the header.{' '}
                    {data.rows.length > 200
                      ? 'Showing the first 200 records; every record is audited.'
                      : ''}{' '}
                    Highlighted cells contain approved changes.
                  </p>
                </TabsContent>
                <TabsContent value="trace">
                  {summary && (
                    <div className="summary-box">
                      <p className="eyebrow">Investigation summary</p>
                      <p>{summary}</p>
                    </div>
                  )}
                  <ol className="trace-list">
                    {traces.map((t, i) => (
                      <li key={i}>
                        <span className="trace-number">{i + 1}</span>
                        <div>
                          <strong>{t.tool}</strong>
                          <p>{t.summary}</p>
                          <small>{new Date(t.at).toLocaleTimeString()}</small>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {!traces.length && (
                    <div className="empty-evidence">
                      <FlaskConical />
                      <p>Run an investigation to see its actual tool calls.</p>
                    </div>
                  )}
                </TabsContent>
                <TabsContent value="ledger">
                  <div className="panelhead">
                    <h2>{decisions.length} recorded decisions</h2>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!decisions.length || busy}
                      onClick={undo}
                    >
                      <RotateCcw /> Undo last decision
                    </Button>
                  </div>
                  <div className="ledger-list">
                    {decisions.map((d) => (
                      <article key={d.id}>
                        <div className="finding-meta">
                          <span>Record {d.finding.rowId}</span>
                          <span className="pill good">
                            {d.action === 'apply'
                              ? 'Applied'
                              : 'Kept unchanged'}
                          </span>
                        </div>
                        <h3>{d.finding.title}</h3>
                        <p>
                          {d.note || 'Approved the evidence-backed proposal.'}
                        </p>
                        <small>{new Date(d.at).toLocaleString()}</small>
                      </article>
                    ))}
                  </div>
                  {!decisions.length && (
                    <div className="empty-evidence">
                      <ShieldCheck />
                      <p>
                        Your decisions will appear here, with evidence and an
                        undo path.
                      </p>
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>
            <div className="bottomline">
              <span>
                <ShieldCheck size={14} /> Original → working copy → documented
                decisions
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!ran || busy}
                onClick={() => setKeyOpen(true)}
              >
                <FlaskConical /> Human answer key
              </Button>
            </div>
          </section>
        </div>
      </div>
      <Dialog open={ruleOpen} onOpenChange={setRuleOpen}>
        <DialogContent className="wide-dialog">
          <DialogHeader>
            <DialogTitle>Define what the data means</DialogTitle>
            <DialogDescription>
              Column mappings are suggestions. Enable repairs only when these
              rules are true for your source.
            </DialogDescription>
          </DialogHeader>
          <div className="rules-grid">
            <section>
              <h3>Record identity</h3>
              <MapField
                label="ID column"
                value={draft.idColumn}
                headers={data.headers}
                onChange={(v) => setDraftField('idColumn', v)}
              />
              <Toggle
                text="Each ID must identify exactly one record"
                value={draft.uniqueIds}
                onChange={(v) => setDraftField('uniqueIds', v)}
              />
              <h3>Missing quantity</h3>
              {(['quantityColumn', 'priceColumn', 'totalColumn'] as const).map(
                (k, i) => (
                  <MapField
                    key={k}
                    label={['Quantity', 'Unit price', 'Total'][i]}
                    value={draft[k]}
                    headers={data.headers}
                    onChange={(v) => setDraftField(k, v)}
                  />
                ),
              )}
              <Toggle
                text="Total = quantity × price; price and total are trusted, with no tax, discount, or refund"
                value={draft.arithmetic}
                onChange={(v) => setDraftField('arithmetic', v)}
              />
              <label className="field" htmlFor="missing-tokens">
                Missing tokens, separated by commas
                <Input
                  id="missing-tokens"
                  value={draft.missingTokens.filter(Boolean).join(',')}
                  onChange={(e) =>
                    setDraftField('missingTokens', [
                      '',
                      ...e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    ])
                  }
                />
              </label>
              <h3>Calendar dates</h3>
              <MapField
                label="Date column (YYYY-MM-DD)"
                value={draft.dateColumn}
                headers={data.headers}
                onChange={(v) => setDraftField('dateColumn', v)}
              />
            </section>
            <section>
              <h3>Approved categories</h3>
              <MapField
                label="Category column"
                value={draft.categoryColumn}
                headers={data.headers}
                onChange={(v) => setDraftField('categoryColumn', v)}
              />
              <label className="field" htmlFor="canonical-labels">
                Canonical labels, separated by commas
                <Input
                  id="canonical-labels"
                  value={draft.categories.join(',')}
                  onChange={(e) =>
                    setDraftField(
                      'categories',
                      e.target.value.split(',').filter(Boolean),
                    )
                  }
                />
              </label>
              <Toggle
                text="These labels are authoritative; normalize spaces and letter case"
                value={draft.normalizeCategories}
                onChange={(v) => setDraftField('normalizeCategories', v)}
              />
              <h3>Explicit mass units</h3>
              <MapField
                label="Mass value"
                value={draft.valueColumn}
                headers={data.headers}
                onChange={(v) => setDraftField('valueColumn', v)}
              />
              <MapField
                label="Unit column"
                value={draft.unitColumn}
                headers={data.headers}
                onChange={(v) => setDraftField('unitColumn', v)}
              />
              <label className="field" htmlFor="target-unit">
                Target unit
                <Select
                  value={draft.targetUnit}
                  onValueChange={(v) =>
                    setDraftField('targetUnit', v as 'kg' | 'g')
                  }
                >
                  <SelectTrigger id="target-unit" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kg">Kilograms (kg)</SelectItem>
                    <SelectItem value="g">Grams (g)</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <Toggle
                text="The source unit is reliable; convert grams / kilograms together with the value"
                value={draft.convertUnits}
                onChange={(v) => setDraftField('convertUnits', v)}
              />
              <h3>Unusual values</h3>
              <MapField
                label="Numeric column"
                value={draft.outlierColumn}
                headers={data.headers}
                onChange={(v) => setDraftField('outlierColumn', v)}
              />
              <Toggle
                text="Flag 1.5 × IQR outliers for human review"
                value={draft.checkOutliers}
                onChange={(v) => setDraftField('checkOutliers', v)}
              />
            </section>
          </div>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setRuleOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveRules}>Save data rules</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="export-dialog">
          <DialogHeader>
            <DialogTitle>Take the evidence with you</DialogTitle>
            <DialogDescription>
              Only approved repairs enter the cleaned CSV. Unresolved findings
              remain visible in the report.
            </DialogDescription>
          </DialogHeader>
          {[
            [
              'Cleaned CSV',
              'The current working copy',
              'cleaned.csv',
              () => toCSV(data),
              'text/csv',
            ],
            [
              'Change ledger',
              'Before, after, evidence and reviewer notes',
              'change-ledger.csv',
              () => ledgerCSV(original, decisions),
              'text/csv',
            ],
            [
              'Audit report',
              'A printable report of findings, decisions and rules',
              'audit-report.html',
              () =>
                reportHTML(original, data, rules, decisions, traces, summary),
              'text/html',
            ],
            [
              'Untouched original',
              'The exact CSV content you started with',
              original.name,
              () => original.original,
              'text/csv',
            ],
          ].map(([title, desc, name, body, mime]) => (
            <Button
              key={String(title)}
              variant="outline"
              className="export-option"
              onClick={() =>
                download(String(name), (body as () => string)(), String(mime))
              }
            >
              <Download />
              <span>
                <strong>{String(title)}</strong>
                <small>{String(desc)}</small>
              </span>
            </Button>
          ))}
        </DialogContent>
      </Dialog>
      <Dialog open={keyOpen} onOpenChange={setKeyOpen}>
        <DialogContent className="wide-dialog">
          <DialogHeader>
            <DialogTitle>Compare against a human-held answer key</DialogTitle>
            <DialogDescription>
              Reveal only after the investigation. The comparison uses frozen
              findings from the first completed investigation, and locks further
              investigations for this case.
            </DialogDescription>
          </DialogHeader>
          <p className="footnote">
            CSV columns: <code>row,check,truth</code>. Row is the stable source
            record number; truth is <code>defect</code> or <code>valid</code>.
            Checks: {CHECKS.join(', ')}. Use independently prepared labels; the
            practice case is not a blind benchmark.
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
                  {['Record', 'Check', 'Human truth', 'Observed result'].map(
                    (h) => (
                      <TableHead key={h}>{h}</TableHead>
                    ),
                  )}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>From messy data to a defensible decision</DialogTitle>
            <DialogDescription>
              The investigator proposes. Evidence supports. You approve.
            </DialogDescription>
          </DialogHeader>
          <ol className="help-list">
            <li>
              <b>1. Profile</b>
              <p>
                Load a CSV and confirm its rules. Missing tokens and column
                meanings come from the source.
              </p>
            </li>
            <li>
              <b>2. Inspect</b>
              <p>
                The AI chooses checks when connected. Deterministic tools
                measure the records and return evidence.
              </p>
            </li>
            <li>
              <b>3. Review</b>
              <p>
                Approve exact repairs, supply a source-verified correction, or
                keep an unusual value with a reason.
              </p>
            </li>
            <li>
              <b>4. Re-check & export</b>
              <p>
                Every decision triggers the configured checks again. Undo
                restores the prior data; export saves the result and reasoning.
              </p>
            </li>
          </ol>
          <p>
            <a
              className="text-primary underline"
              href={publicAsset('cleanroom-detective-explainer.pdf')}
              target="_blank"
              rel="noreferrer"
            >
              Open the visual explanation (PDF)
            </a>{' '}
            ·{' '}
            <a
              className="text-primary underline"
              href={publicAsset('cleanroom-detective-explainer.tex')}
              download
            >
              LaTeX source
            </a>
          </p>
          <p className="footnote">
            {STATIC_DEMO
              ? 'This shared demo runs the rules audit without a language model. Your CSV stays in this tab. '
              : 'AI receives bounded numerical statistics and check outcomes, not raw CSV cells. Rules audits stay in your tab. '}
            For a real evaluation, keep the human answer key hidden until the
            first investigation completes.
          </p>
        </DialogContent>
      </Dialog>
    </main>
  );
}
