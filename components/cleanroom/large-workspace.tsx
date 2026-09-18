'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  ScanSearch,
  Upload,
  ArrowRight,
  FileSpreadsheet,
  Download,
  Check,
  RotateCcw,
  ShieldCheck,
  LogOut,
  FolderOpen,
  SlidersHorizontal,
  ArrowLeft,
  X,
  Pause,
  Play,
  Trash2,
  LoaderCircle,
  CircleHelp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Progress } from '@/components/ui/progress';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { findingMeta, similarFindings } from '@/lib/audit-options';
import { printReport, summaryReport } from '@/lib/report';
import { CheckSettings } from './check-settings';
import {
  SAMPLE_RULES,
  availableChecks,
  validateRules,
  type Rules,
  type Row,
  type Finding,
} from '@/lib/audit';
import type { LargeJob, LargeFinding, LargeSession } from '@/lib/large-types';
import type { LargeBackend } from '@/lib/browser-backend';

const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const waiting = (j: LargeJob | null) =>
  j?.state === 'working' || j?.state === 'queued';
async function serverRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api/large/${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Cleanroom': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok)
    throw new Error(
      data.error || 'The request could not finish. Please try again.',
    );
  return data as T;
}
const plainTitle = (f: Finding) =>
  ({
    duplicates: f.patch
      ? 'This row appears twice'
      : 'These IDs need a closer look',
    arithmetic: f.patch
      ? 'Fill in a missing quantity'
      : 'A quantity needs checking',
    dates: 'This date needs checking',
    categories: f.patch ? 'Make this label consistent' : 'Check this label',
    units: f.patch ? 'Use the same unit' : 'Check this measurement',
    outliers: 'An unusual value to double-check',
    required: 'A required value is missing',
    email: 'Check this email address',
    range: 'Check this numeric value',
  })[f.check];
export function LargeWorkspace({
  backend,
  initialFile,
  onBack,
}: {
  backend?: LargeBackend;
  initialFile?: File | null;
  onBack?: () => void;
} = {}) {
  const request = backend?.request ?? serverRequest;
  const local = backend?.mode === 'browser';
  const [exporting, setExporting] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [session, setSession] = useState<LargeSession | null>(null),
    [loaded, setLoaded] = useState(false);
  const [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [signingIn, setSigningIn] = useState(false);
  const [jobs, setJobs] = useState<LargeJob[]>([]),
    [job, setJob] = useState<LargeJob | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false),
    [uploadOffset, setUploadOffset] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false),
    [draft, setDraft] = useState<Rules>(SAMPLE_RULES);
  const [findings, setFindings] = useState<LargeFinding[]>([]),
    [selected, setSelected] = useState<LargeFinding | null>(null);
  const [filter, setFilter] = useState('pending'),
    [cursor, setCursor] = useState({ row: 0, id: '', priority: 1000 });
  const [rows, setRows] = useState<(Row & { changed: boolean })[]>([]),
    [rowCursor, setRowCursor] = useState(0);
  const [relatedRow, setRelatedRow] = useState<number | null>(null);
  const [decisions, setDecisions] = useState<
    {
      seq: number;
      action: string;
      note: string;
      at: string;
      finding: Finding;
    }[]
  >([]);
  const [note, setNote] = useState(''),
    [manual, setManual] = useState(''),
    [manualOpen, setManualOpen] = useState(false);
  const [tab, setTab] = useState('review'),
    [deleteOpen, setDeleteOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    uploadAbort = useRef<AbortController | null>(null);
  const currentUpload = useRef<LargeJob | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const summary = job?.summary;
  const similar = selected
    ? (similarFindings(
        findings.slice(0, 30).filter((f) => !f.reviewed),
        selected,
      ) as LargeFinding[])
    : [];
  const busy = waiting(job);
  const refreshJobs = useCallback(async () => {
    setJobs(await request<LargeJob[]>('jobs'));
  }, [request]);
  useEffect(() => {
    request<LargeSession>('session')
      .then((s) => {
        setSession(s);
        void refreshJobs();
      })
      .catch((e) => {
        if (local) setError(e.message);
      })
      .finally(() => setLoaded(true));
    return () => uploadAbort.current?.abort();
  }, [refreshJobs, request, local]);
  useEffect(() => {
    if (!job || !waiting(job)) return;
    let alive = true;
    const id = setInterval(() => {
      request<LargeJob>(`jobs/${job.id}`)
        .then((next) => {
          if (!alive) return;
          setJob(next);
          if (!waiting(next)) {
            setCursor({ row: 0, id: '', priority: 1000 });
            setSelected(null);
            void refreshJobs();
            if (next.error) setError(next.error);
          }
        })
        .catch((e) => {
          if (alive) setError(String(e.message));
        });
    }, 1200);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [job, refreshJobs, request]);
  useEffect(() => {
    if (!job || job.state !== 'complete') {
      return;
    }
    let alive = true;
    request<LargeFinding[]>(
      `jobs/${job.id}/findings?filter=${filter}&afterRow=${cursor.row}&afterId=${encodeURIComponent(cursor.id)}&afterPriority=${cursor.priority}`,
    )
      .then((items) => {
        if (!alive) return;
        setFindings(items);
        setSelected(items[0] ?? null);
        setNote('');
        setManual('');
        setManualOpen(false);
      })
      .catch((e) => {
        if (alive) setError(String(e.message));
      });
    return () => {
      alive = false;
    };
  }, [job, filter, cursor, request]);
  useEffect(() => {
    if (!job || !['ready', 'complete'].includes(job.state)) return;
    let alive = true;
    if (tab === 'data' || job.state === 'ready')
      request<(Row & { changed: boolean })[]>(
        `jobs/${job.id}/rows?after=${rowCursor}${relatedRow === null ? '' : `&relatedRow=${relatedRow}`}`,
      )
        .then((v) => {
          if (alive) setRows(v);
        })
        .catch((e) => {
          if (alive) setError(String(e.message));
        });
    if (tab === 'changes')
      request<typeof decisions>(`jobs/${job.id}/decisions`)
        .then((v) => {
          if (alive) setDecisions(v);
        })
        .catch((e) => {
          if (alive) setError(String(e.message));
        });
    return () => {
      alive = false;
    };
  }, [job, tab, rowCursor, relatedRow, request]);
  async function signIn(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setSigningIn(true);
    try {
      await request('login', 'POST', { username, password });
      setPassword('');
      setSession(await request<LargeSession>('session'));
      await refreshJobs();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
    } finally {
      setSigningIn(false);
    }
  }
  async function task(action: string, body?: unknown) {
    if (!job || (busy && action !== 'cancel') || uploading || exporting) return;
    try {
      setError('');
      setNotice('');
      setJob(await request<LargeJob>(`jobs/${job.id}/${action}`, 'POST', body));
      setNote('');
      setManual('');
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'The request could not finish.',
      );
    }
  }
  function openJob(next: LargeJob) {
    setJob(next);
    setCursor({ row: 0, id: '', priority: 1000 });
    setRowCursor(0);
    setRelatedRow(null);
    setFilter('pending');
    setTab('review');
    setError('');
    setNotice('');
    setDraft(next.summary?.rules ?? SAMPLE_RULES);
  }
  async function upload(file: File) {
    if (!session || uploading) return;
    setError('');
    setNotice('');
    setUploading(true);
    const abort = new AbortController();
    uploadAbort.current = abort;
    try {
      if (!file.name.toLowerCase().endsWith('.csv'))
        throw new Error('Choose a CSV file.');
      if (file.size > session.maxUploadBytes)
        throw new Error(
          `Choose a file up to ${formatSize(session.maxUploadBytes)}.`,
        );
      let next: LargeJob;
      if (resumeId) {
        next = await request<LargeJob>(`jobs/${resumeId}`);
        if (next.name !== file.name.slice(0, 120) || next.size !== file.size)
          throw new Error(
            'Select the same file name and size to resume this upload.',
          );
        const chunks = await request<
          { offset: number; length: number; sha256: string }[]
        >(`jobs/${next.id}/chunks`);
        for (const chunk of chunks) {
          if (abort.signal.aborted)
            throw new DOMException('Paused', 'AbortError');
          const bytes = await file
            .slice(chunk.offset, chunk.offset + chunk.length)
            .arrayBuffer();
          const digest = [
            ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          ]
            .map((n) => n.toString(16).padStart(2, '0'))
            .join('');
          if (digest !== chunk.sha256)
            throw new Error(
              'This file differs from the uploaded copy. Choose the original file or start a new upload.',
            );
        }
      } else
        next = await request<LargeJob>('jobs', 'POST', {
          name: file.name,
          size: file.size,
        });
      setJob(next);
      currentUpload.current = next;
      setUploadOffset(next.offset);
      while (next.offset < file.size) {
        if (abort.signal.aborted)
          throw new DOMException('Paused', 'AbortError');
        const end = Math.min(file.size, next.offset + session.chunkBytes);
        let result: { error?: string; offset: number };
        if (backend)
          result = await backend.writeChunk(
            next.id,
            next.offset,
            file.slice(next.offset, end),
            abort.signal,
          );
        else {
          const res = await fetch(`/api/large/jobs/${next.id}/chunk`, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Cleanroom': '1',
              'Upload-Offset': String(next.offset),
            },
            body: file.slice(next.offset, end),
            signal: abort.signal,
          });
          result = (await res.json()) as { error?: string; offset: number };
          if (!res.ok)
            throw new Error(
              result.error || 'Upload paused. Resume to retry this chunk.',
            );
        }
        next = { ...next, offset: result.offset };
        currentUpload.current = next;
        setUploadOffset(next.offset);
        setJob(next);
      }
      const finished = await request<LargeJob>(
        `jobs/${next.id}/finish`,
        'POST',
      );
      setJob(finished);
      setResumeId(null);
      await refreshJobs();
    } catch (e) {
      const paused = e instanceof Error && e.name === 'AbortError';
      if (paused)
        setNotice(
          'Upload paused. Choose the same file when you’re ready to resume.',
        );
      else
        setError(
          e instanceof Error ? e.message : 'Upload paused. Try resuming.',
        );
      if (currentUpload.current) {
        try {
          const fresh = await request<LargeJob>(
            `jobs/${currentUpload.current.id}`,
          );
          setJob(fresh);
          setUploadOffset(fresh.offset);
        } catch {
          /* Keep the last confirmed position. */
        }
      }
      await refreshJobs().catch(() => {});
    } finally {
      setUploading(false);
      uploadAbort.current = null;
      currentUpload.current = null;
    }
  }
  const downloadHref = (kind: string) =>
    `/api/large/jobs/${job?.id}/download?kind=${kind}`;
  async function downloadFile(kind: string) {
    if (!job || exporting) return;
    if (!backend) {
      window.location.assign(downloadHref(kind));
      return;
    }
    setError('');
    const name =
      kind === 'original'
        ? job.name
        : kind === 'updated'
          ? job.name.replace(/\.csv$/i, '') + '-updated.csv'
          : kind === 'report'
            ? 'review-report.html'
            : kind === 'unresolved'
              ? 'unresolved-issues.csv'
              : 'changes.csv';
    try {
      const pending = backend.download(job.id, kind, name);
      setExporting(true);
      setNotice('Saving your complete file. Keep this tab open…');
      await pending;
      setNotice('Your file was saved.');
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setError(
          e instanceof Error ? e.message : 'The download could not finish.',
        );
      setNotice('');
    } finally {
      setExporting(false);
    }
  }
  function choose(f: LargeFinding) {
    setSelected(f);
    setNote('');
    setManual('');
    setManualOpen(false);
  }
  return (
    <main className="shell large-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">
            <ScanSearch />
          </span>
          <span>
            Cleanroom Detective<small>Room for your larger spreadsheets</small>
          </span>
        </div>
        {local && onBack && (
          <Button
            variant="ghost"
            disabled={uploading || busy || exporting}
            onClick={onBack}
          >
            <ArrowLeft /> Small-file demo
          </Button>
        )}
        {session && !local && (
          <Button
            variant="ghost"
            disabled={uploading || busy}
            onClick={async () => {
              await request('logout', 'POST');
              setSession(null);
              setJobs([]);
              setJob(null);
            }}
          >
            <LogOut size={16} /> Sign out
          </Button>
        )}
      </header>
      {error && (
        <div className="global-message error-banner" role="alert">
          <CircleHelp size={19} />
          <span>{error}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Dismiss error"
            onClick={() => setError('')}
          >
            <X />
          </Button>
        </div>
      )}
      {!loaded ? (
        <div className="empty-detail">
          <LoaderCircle className="animate-spin" />
          Opening your workspace…
        </div>
      ) : !session && local ? (
        <section className="large-login">
          <h1>Let’s open this in a supported browser.</h1>
          <p>{error || 'Browser storage is not available.'}</p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
          {onBack && (
            <Button variant="ghost" onClick={onBack}>
              Back to the example
            </Button>
          )}
        </section>
      ) : !session ? (
        <section className="large-login">
          <span className="soft-icon">
            <ShieldCheck />
          </span>
          <p className="eyebrow">Your private workspace</p>
          <h1>A little space for bigger files.</h1>
          <p>
            Sign in to upload a large CSV, review suggestions, and download your
            updated copy.
          </p>
          <form onSubmit={signIn}>
            <label className="field" htmlFor="large-user">
              Account name
              <Input
                id="large-user"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>
            <label className="field" htmlFor="large-password">
              Password
              <Input
                id="large-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            <Button
              className="primary-large"
              type="submit"
              disabled={signingIn}
            >
              {signingIn ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <ArrowRight />
              )}{' '}
              Sign in
            </Button>
          </form>
          <small>
            Ask your workspace owner for an account. Files are private to the
            account that uploads them.
          </small>
        </section>
      ) : (
        <div className="review-workspace">
          <input
            type="file"
            accept=".csv,text/csv"
            hidden
            ref={input}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = '';
            }}
          />
          {notice && <output className="decision-message">{notice}</output>}
          {!job ? (
            <>
              <section className="large-intro">
                <div>
                  <p className="eyebrow">
                    {local
                      ? 'Private to this browser'
                      : `Hello, ${session.username}`}
                  </p>
                  <h1>Your files, with room to grow.</h1>
                  <p>
                    {local ? 'Open' : 'Upload'} a CSV up to{' '}
                    {formatSize(session.maxUploadBytes)}.
                    {local
                      ? ' Your file stays on this device. Keep this tab open while it works.'
                      : ' We’ll check it in the background. You can come back later.'}
                  </p>
                </div>
                <Button
                  className="primary-large"
                  onClick={() => {
                    setResumeId(null);
                    if (initialFile) void upload(initialFile);
                    else input.current?.click();
                  }}
                >
                  <Upload />{' '}
                  {initialFile ? `Open ${initialFile.name}` : 'Choose a CSV'}
                </Button>
              </section>
              <div className="server-privacy">
                <ShieldCheck size={20} />
                <p>
                  {local
                    ? 'Files are processed on your device and never uploaded. Your original stays unchanged. Saved work belongs to this browser; clearing site data removes it. Files older than 24 hours are removed when you next open this workspace.'
                    : `Large files are uploaded to this private workspace. Your original stays unchanged. Files and results are deleted ${session.retentionHours} hours after upload begins.`}
                </p>
              </div>
              <section className="data-card">
                <div className="panelhead">
                  <div>
                    <h2>Your files</h2>
                    <p>
                      {local
                        ? 'Files saved in this browser appear here.'
                        : 'Only files belonging to this account appear here.'}
                    </p>
                  </div>
                  <Button variant="ghost" onClick={() => void refreshJobs()}>
                    <RotateCcw size={16} /> Refresh
                  </Button>
                </div>
                {jobs.length ? (
                  <div className="job-list">
                    {jobs.map((item) => (
                      <button key={item.id} onClick={() => openJob(item)}>
                        <span className="file-badge">
                          <FileSpreadsheet />
                        </span>
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {formatSize(item.size)} · {item.phase}
                          </small>
                        </span>
                        <span className="job-expiry">
                          {local
                            ? 'Saved on this device'
                            : `Expires ${new Date(item.expires).toLocaleString()}`}
                        </span>
                        <ArrowRight size={18} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty-detail">
                    <FolderOpen />
                    <h2>Your first file starts here.</h2>
                    <p>
                      Choose a CSV above. You’ll see upload progress and can
                      pause or resume.
                    </p>
                  </div>
                )}
              </section>
            </>
          ) : (
            <>
              <div className="file-ribbon">
                <span className="file-badge">
                  <FileSpreadsheet />
                </span>
                <div>
                  <strong>{job.name}</strong>
                  <span>
                    {formatSize(job.size)}
                    {summary
                      ? ` · ${summary.records.toLocaleString()} rows`
                      : ''}
                  </span>
                </div>
                <div className="file-actions">
                  <Button
                    variant="ghost"
                    disabled={uploading}
                    onClick={() => {
                      setJob(null);
                      void refreshJobs();
                    }}
                  >
                    <ArrowLeft size={16} /> Your files
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={uploading || busy}
                    onClick={() => setDeleteOpen(true)}
                    aria-label="Delete this file"
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              </div>
              <p className="retention-note">
                Private to your account · Expires{' '}
                {new Date(job.expires).toLocaleString()}
              </p>
              {job.state === 'uploading' ? (
                <section className="checking-card">
                  <div className="checking-symbol">
                    <Upload />
                  </div>
                  <h1>
                    {uploading
                      ? 'Making room for your file…'
                      : 'Ready when you are.'}
                  </h1>
                  <p>
                    {formatSize(uploading ? uploadOffset : job.offset)} of{' '}
                    {formatSize(job.size)} uploaded
                  </p>
                  <Progress
                    value={
                      ((uploading ? uploadOffset : job.offset) / job.size) * 100
                    }
                    aria-label="Upload progress"
                  />
                  <p className="setting-help">
                    Keep this tab open during upload. If it pauses, choose the
                    same file to resume from the last completed chunk.
                  </p>
                  {uploading ? (
                    <Button
                      variant="outline"
                      onClick={() => uploadAbort.current?.abort()}
                    >
                      <Pause /> Pause upload
                    </Button>
                  ) : (
                    <Button
                      className="primary-large"
                      onClick={() => {
                        setResumeId(job.id);
                        input.current?.click();
                      }}
                    >
                      <Play /> Resume upload
                    </Button>
                  )}
                </section>
              ) : busy ? (
                <section className="checking-card" aria-live="polite">
                  <div className="checking-symbol">
                    <LoaderCircle className="animate-spin" size={28} />
                  </div>
                  <p className="eyebrow">Working in the background</p>
                  <h1>{job.phase}</h1>
                  <p>{job.records.toLocaleString()} source rows read</p>
                  {job.task === 'import' && (
                    <Progress
                      value={Math.min(99, (job.progress / job.size) * 100)}
                      aria-label="Reading progress"
                    />
                  )}
                  <p className="setting-help">
                    {local
                      ? 'Keep this tab open until the task finishes. Your original remains unchanged.'
                      : 'You can leave and return to this workspace. Your original remains unchanged.'}
                  </p>
                  <Button variant="ghost" onClick={() => void task('cancel')}>
                    Stop this task
                  </Button>
                </section>
              ) : ['failed', 'cancelled'].includes(job.state) ? (
                <section className="finished-card">
                  <CircleHelp className="finish-symbol" />
                  <h2>Let’s pick up where we left off.</h2>
                  <p>{job.error || 'This file needs another try.'}</p>
                  <Button
                    className="primary-large"
                    onClick={() => void task('retry')}
                  >
                    <RotateCcw /> Retry
                  </Button>
                </section>
              ) : job.state === 'ready' && summary ? (
                <section className="ready-card">
                  <div className="ready-copy">
                    <span className="soft-icon">
                      <ScanSearch />
                    </span>
                    <p className="eyebrow">Your file is ready</p>
                    <h1>Let’s see what needs attention.</h1>
                    <p>
                      We read all {summary.records.toLocaleString()} rows.
                      Choose the checks that match your file, then review each
                      suggestion before anything changes.
                    </p>
                    <div className="ready-actions">
                      <Button
                        className="primary-large"
                        onClick={() =>
                          availableChecks(summary.rules).length
                            ? void task('check', { rules: summary.rules })
                            : (setDraft(summary.rules), setRulesOpen(true))
                        }
                      >
                        <ScanSearch />
                        {availableChecks(summary.rules).length
                          ? 'Check my file'
                          : 'Choose columns to check'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setDraft(summary.rules);
                          setRulesOpen(true);
                        }}
                      >
                        <SlidersHorizontal /> Set goal & adjust checks
                      </Button>
                    </div>
                  </div>
                  <div className="large-rule-note">
                    <ShieldCheck />
                    <h2>You choose every change.</h2>
                    <p>
                      Checks use confirmed rules. Uncertain values stay for your
                      review, and your original file remains available.
                    </p>
                    <p>Processing runs without a paid AI connection.</p>
                    <h3>A peek at your file</h3>
                    <div className="dataset-scroll">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {summary.headers.slice(0, 3).map((h) => (
                              <TableHead key={h}>{h}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.slice(0, 3).map((r) => (
                            <TableRow key={r.id}>
                              {r.cells.slice(0, 3).map((c, i) => (
                                <TableCell key={i}>{c || '—'}</TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </section>
              ) : (
                summary && (
                  <>
                    <div className="results-heading">
                      <div>
                        <p className="eyebrow">One clear decision at a time</p>
                        <h1>
                          {summary.pending
                            ? 'Let’s take a closer look.'
                            : 'Your review is complete.'}
                        </h1>
                        <p>
                          {summary.pending.toLocaleString()} items to review ·{' '}
                          {summary.repairs.toLocaleString()} suggested fixes ·{' '}
                          {summary.applied.toLocaleString()} changes applied
                        </p>
                      </div>
                      <Button
                        disabled={exporting}
                        onClick={() => void downloadFile('updated')}
                        className="download-top"
                      >
                        <Download /> Download updated CSV
                      </Button>
                    </div>
                    <Tabs
                      value={tab}
                      onValueChange={(v) => setTab(String(v))}
                      className="work-tabs"
                    >
                      <div className="review-navigation">
                        <TabsList variant="line">
                          <TabsTrigger value="review">Review</TabsTrigger>
                          <TabsTrigger value="data">Your data</TabsTrigger>
                          <TabsTrigger value="changes">Changes</TabsTrigger>
                          <TabsTrigger value="downloads">Downloads</TabsTrigger>
                        </TabsList>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (summary.decisions) {
                              setNotice(
                                'Undo saved decisions before changing checks, or upload a separate copy.',
                              );
                              return;
                            }
                            setDraft(summary.rules);
                            setRulesOpen(true);
                          }}
                        >
                          <SlidersHorizontal /> Set goal & adjust checks
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={!summary.decisions}
                          onClick={() => void task('undo')}
                        >
                          <RotateCcw /> Undo last decision
                        </Button>
                      </div>
                      <TabsContent value="review">
                        {!summary.pending && filter === 'pending' ? (
                          <section className="finished-card">
                            <span className="finish-symbol">
                              <Check />
                            </span>
                            <h2>All decisions saved.</h2>
                            <p>
                              Your updated copy includes only changes you
                              approved. Items kept unchanged remain in the
                              report.
                            </p>
                            <Button
                              disabled={exporting}
                              onClick={() => void downloadFile('updated')}
                              className="primary-large"
                            >
                              <Download /> Download updated CSV
                            </Button>
                            <div className="finished-links">
                              <Button
                                variant="ghost"
                                onClick={() => {
                                  setFilter('all');
                                  setCursor({ row: 0, id: '', priority: 1000 });
                                }}
                              >
                                View current findings
                              </Button>
                              <Button
                                variant="ghost"
                                onClick={() => setTab('downloads')}
                              >
                                Report & other files
                              </Button>
                            </div>
                          </section>
                        ) : (
                          <div className="review-grid">
                            <aside className="suggestions">
                              <div className="suggestion-tools">
                                <label className="field" htmlFor="large-filter">
                                  Show
                                  <select
                                    id="large-filter"
                                    className="large-select"
                                    value={filter}
                                    onChange={(e) => {
                                      setFilter(e.target.value);
                                      setCursor({
                                        row: 0,
                                        id: '',
                                        priority: 1000,
                                      });
                                    }}
                                  >
                                    <option value="pending">To review</option>
                                    <option value="repair">
                                      Suggested fixes
                                    </option>
                                    <option value="review">
                                      Needs a closer look
                                    </option>
                                    <option value="all">
                                      All current findings
                                    </option>
                                  </select>
                                </label>
                              </div>
                              <div className="suggestion-list">
                                {findings.slice(0, 30).map((f) => (
                                  <button
                                    key={f.id}
                                    className={`suggestion-row ${selected?.id === f.id ? 'selected' : ''}`}
                                    aria-pressed={selected?.id === f.id}
                                    onClick={() => choose(f)}
                                  >
                                    <span
                                      className={`suggestion-dot ${f.patch ? 'fix' : 'look'}`}
                                    >
                                      {f.reviewed ? (
                                        <Check size={15} />
                                      ) : f.patch ? (
                                        <SlidersHorizontal size={15} />
                                      ) : (
                                        <CircleHelp size={15} />
                                      )}
                                    </span>
                                    <span>
                                      <small>
                                        Row {f.rowId} · {f.column}
                                      </small>
                                      <strong>{plainTitle(f)}</strong>
                                      <em>
                                        {f.reviewed
                                          ? 'Reviewed'
                                          : f.patch
                                            ? 'Suggested fix'
                                            : 'Take a look'}
                                      </em>
                                    </span>
                                  </button>
                                ))}
                                {!findings.length && (
                                  <div className="list-empty">
                                    No matching items on this page.
                                  </div>
                                )}
                              </div>
                              <div className="pagination">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={!cursor.row}
                                  onClick={() =>
                                    setCursor({
                                      row: 0,
                                      id: '',
                                      priority: 1000,
                                    })
                                  }
                                >
                                  First page
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={findings.length <= 30}
                                  onClick={() => {
                                    const last = findings[29];
                                    setCursor({
                                      row: last.rowId,
                                      id: last.id,
                                      priority: last.priority,
                                    });
                                  }}
                                >
                                  Next 30 <ArrowRight size={14} />
                                </Button>
                              </div>
                            </aside>
                            <section className="suggestion-detail">
                              {selected ? (
                                <>
                                  <p className="finding-priority">
                                    {findingMeta(selected).severity} priority ·{' '}
                                    {findingMeta(selected).confidence}
                                  </p>
                                  <div className="detail-top">
                                    <span
                                      className={`kind-label ${selected.patch ? 'fix' : 'look'}`}
                                    >
                                      {selected.reviewed
                                        ? 'Reviewed'
                                        : selected.patch
                                          ? 'Suggested fix'
                                          : 'Take a look'}
                                    </span>
                                    <span>
                                      Row {selected.rowId.toLocaleString()} ·{' '}
                                      {selected.column}
                                    </span>
                                  </div>
                                  <h2 aria-live="polite">
                                    {plainTitle(selected)}
                                  </h2>
                                  <p className="detail-description">
                                    {selected.detail}
                                  </p>
                                  {selected.patch ? (
                                    <div className="before-after">
                                      {selected.patch.deleteRow ? (
                                        <>
                                          <div>
                                            <span>Now</span>
                                            <strong>Extra copy</strong>
                                          </div>
                                          <ArrowRight />
                                          <div className="after-value">
                                            <span>After approval</span>
                                            <strong>Keep one row</strong>
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
                                                {summary.headers[c.column]} ·
                                                now
                                              </span>
                                              <strong>
                                                {c.before || '(empty)'}
                                              </strong>
                                            </div>
                                            <ArrowRight />
                                            <div className="after-value">
                                              <span>Suggested value</span>
                                              <strong>{c.after}</strong>
                                            </div>
                                          </div>
                                        ))
                                      )}
                                    </div>
                                  ) : (
                                    <div className="review-callout">
                                      <CircleHelp />
                                      <div>
                                        <strong>
                                          This needs your judgment.
                                        </strong>
                                        <p>
                                          Keep it as is unless a reliable source
                                          supports a correction.
                                        </p>
                                      </div>
                                    </div>
                                  )}
                                  <Accordion className="evidence-accordion">
                                    <AccordionItem value="why">
                                      <AccordionTrigger>
                                        Why this suggestion?
                                      </AccordionTrigger>
                                      <AccordionContent>
                                        <ol>
                                          {selected.evidence.map((e, i) => (
                                            <li key={i}>{e}</li>
                                          ))}
                                        </ol>
                                        {selected.check === 'duplicates' && (
                                          <Button
                                            variant="ghost"
                                            onClick={() => {
                                              setRelatedRow(selected.rowId);
                                              setRowCursor(0);
                                              setTab('data');
                                            }}
                                          >
                                            Show related rows
                                          </Button>
                                        )}
                                      </AccordionContent>
                                    </AccordionItem>
                                  </Accordion>
                                  {selected.reviewed ? (
                                    <div className="saved-decision">
                                      <Check />
                                      <p>
                                        Your decision is saved. Use Changes to
                                        see it, or undo the last decision.
                                      </p>
                                    </div>
                                  ) : (
                                    <div className="review-actions">
                                      <label
                                        className="field note-field"
                                        htmlFor="large-note"
                                      >
                                        Add a note{' '}
                                        <span>
                                          {manualOpen
                                            ? '(source required)'
                                            : '(optional)'}
                                        </span>
                                        <Textarea
                                          id="large-note"
                                          value={note}
                                          onChange={(e) =>
                                            setNote(e.target.value)
                                          }
                                          maxLength={2000}
                                          rows={2}
                                          placeholder="Anything you’d like to remember…"
                                        />
                                      </label>
                                      <div className="decision-buttons">
                                        {selected.patch && (
                                          <Button
                                            className="primary-large"
                                            onClick={() =>
                                              void task('decide', {
                                                id: selected.id,
                                                fingerprint:
                                                  selected.fingerprint,
                                                action: 'apply',
                                                note,
                                              })
                                            }
                                          >
                                            <Check /> Apply this fix
                                          </Button>
                                        )}
                                        <Button
                                          variant={
                                            selected.patch
                                              ? 'outline'
                                              : 'default'
                                          }
                                          className={
                                            selected.patch
                                              ? 'keep-button'
                                              : 'primary-large'
                                          }
                                          onClick={() =>
                                            void task('decide', {
                                              id: selected.id,
                                              fingerprint: selected.fingerprint,
                                              action: 'keep',
                                              note,
                                            })
                                          }
                                        >
                                          Keep as is
                                        </Button>
                                      </div>
                                      {!selected.patch?.deleteRow && (
                                        <>
                                          <Button
                                            variant="ghost"
                                            className="manual-toggle"
                                            onClick={() =>
                                              setManualOpen((v) => !v)
                                            }
                                          >
                                            I know the correct value
                                          </Button>
                                          {manualOpen && (
                                            <div className="manual-fields">
                                              <label
                                                className="field"
                                                htmlFor="large-correction"
                                              >
                                                Verified value
                                                <Input
                                                  id="large-correction"
                                                  value={manual}
                                                  onChange={(e) =>
                                                    setManual(e.target.value)
                                                  }
                                                  maxLength={4000}
                                                />
                                              </label>
                                              <p className="setting-help">
                                                Describe the source in your note
                                                above.
                                              </p>
                                              <Button
                                                variant="outline"
                                                onClick={() =>
                                                  void task('decide', {
                                                    id: selected.id,
                                                    fingerprint:
                                                      selected.fingerprint,
                                                    action: 'apply',
                                                    note,
                                                    manual,
                                                  })
                                                }
                                              >
                                                Save my correction
                                              </Button>
                                            </div>
                                          )}
                                        </>
                                      )}
                                      {similar.length > 1 && (
                                        <Button
                                          variant="outline"
                                          onClick={() => setBulkOpen(true)}
                                        >
                                          Preview {similar.length} similar fixes
                                          on this page
                                        </Button>
                                      )}
                                      <p className="undo-hint">
                                        <RotateCcw size={14} />
                                        Undo restores the previous values.
                                      </p>
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="empty-detail">
                                  <CircleHelp />
                                  <h2>Choose an item to review.</h2>
                                </div>
                              )}
                            </section>
                          </div>
                        )}
                      </TabsContent>
                      <TabsContent value="data">
                        <section className="data-card">
                          <div className="panelhead">
                            <div>
                              <h2>Your updated spreadsheet</h2>
                              <p>
                                Showing up to 50 rows at a time. Downloads
                                include all rows.
                              </p>
                            </div>
                            <div className="pagination">
                              {relatedRow !== null && (
                                <Button
                                  variant="outline"
                                  onClick={() => {
                                    setRelatedRow(null);
                                    setRowCursor(0);
                                  }}
                                >
                                  Show all rows
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                disabled={!rowCursor}
                                onClick={() => setRowCursor(0)}
                              >
                                First rows
                              </Button>
                              <Button
                                variant="outline"
                                disabled={rows.length < 50}
                                onClick={() => setRowCursor(rows.at(-1)!.id)}
                              >
                                Next rows <ArrowRight size={15} />
                              </Button>
                            </div>
                          </div>
                          <div className="dataset-scroll">
                            <Table className="data-table">
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Source row</TableHead>
                                  {summary.headers.map((h) => (
                                    <TableHead key={h}>{h}</TableHead>
                                  ))}
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {rows.map((r) => (
                                  <TableRow key={r.id}>
                                    <TableCell>
                                      {r.id.toLocaleString()}
                                    </TableCell>
                                    {r.cells.map((c, i) => (
                                      <TableCell
                                        key={i}
                                        className={
                                          r.changed ? 'changed-cell' : ''
                                        }
                                      >
                                        {c || (
                                          <span className="missing-cell">
                                            empty
                                          </span>
                                        )}
                                      </TableCell>
                                    ))}
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </div>
                        </section>
                      </TabsContent>
                      <TabsContent value="changes">
                        <section className="data-card">
                          <div className="panelhead">
                            <div>
                              <h2>Your decisions</h2>
                              <p>
                                {summary.applied} changes · {summary.kept} kept
                                as is. Changed evidence can bring an item back
                                for review.
                              </p>
                            </div>
                            <Button
                              variant="outline"
                              disabled={exporting}
                              onClick={() => void downloadFile('changes')}
                            >
                              <Download /> All decisions
                            </Button>
                          </div>
                          <div className="ledger-list">
                            {decisions.map((d) => (
                              <article key={d.seq}>
                                <span className="ledger-icon">
                                  <Check />
                                </span>
                                <div>
                                  <small>
                                    Row {d.finding.rowId} ·{' '}
                                    {new Date(d.at).toLocaleString()}
                                  </small>
                                  <h3>{plainTitle(d.finding)}</h3>
                                  {d.action === 'apply' && (
                                    <p>
                                      {d.finding.patch?.deleteRow
                                        ? 'Removed duplicate row'
                                        : d.finding.patch?.changes
                                            .map(
                                              (c) =>
                                                `${summary.headers[c.column]}: ${c.before || '(empty)'} → ${c.after}`,
                                            )
                                            .join('; ')}
                                    </p>
                                  )}
                                  <small>Rule: {d.finding.check}</small>
                                  <p>{d.note || 'You approved this change.'}</p>
                                </div>
                                <span className="quiet-tag">
                                  {d.action === 'apply'
                                    ? 'Updated'
                                    : 'Kept as is'}
                                </span>
                              </article>
                            ))}
                          </div>
                          {decisions.length === 30 && (
                            <p className="table-note">
                              Showing your latest 30 decisions. Download the
                              complete list above.
                            </p>
                          )}
                          {!decisions.length && (
                            <div className="empty-detail">
                              <h2>Your decisions will appear here.</h2>
                            </div>
                          )}
                        </section>
                      </TabsContent>
                      <TabsContent value="downloads">
                        <section className="data-card">
                          <div className="panelhead">
                            <div>
                              <h2>Take your work with you.</h2>
                              <p>
                                {summary.pending
                                  ? `${summary.pending.toLocaleString()} items still need review. Only approved changes are included.`
                                  : 'Only your approved changes are included.'}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            onClick={() => {
                              try {
                                printReport(
                                  summaryReport(
                                    summary,
                                    findings.slice(0, 30),
                                    decisions,
                                  ),
                                );
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            <Download /> Save summary as PDF
                          </Button>
                          <p className="setting-help">
                            Choose “Save as PDF” in the print dialog. The
                            summary includes counts, rules, and up to 30
                            currently loaded findings and decisions. Download
                            the reports below for complete records.
                          </p>
                          <div className="large-downloads">
                            {[
                              [
                                'updated',
                                'Updated CSV',
                                'Every row, with approved changes',
                              ],
                              [
                                'original',
                                'Original file',
                                'Exactly the bytes you uploaded',
                              ],
                              [
                                'changes',
                                'List of changes',
                                'Before and after values and your notes',
                              ],
                              [
                                'unresolved',
                                'Unresolved issues',
                                'All current flags, including values kept unchanged',
                              ],
                              [
                                'report',
                                'Review report',
                                'All current findings and decisions',
                              ],
                            ].map(([kind, title, desc]) => (
                              <Button
                                key={kind}
                                variant="outline"
                                disabled={exporting}
                                onClick={() => void downloadFile(kind)}
                              >
                                <Download />
                                <span>
                                  <strong>{title}</strong>
                                  <small>{desc}</small>
                                </span>
                                <ArrowRight />
                              </Button>
                            ))}
                          </div>
                        </section>
                      </TabsContent>
                    </Tabs>
                    <div className="workspace-foot">
                      <span>
                        <ShieldCheck size={16} />
                        Your original stays unchanged.
                      </span>
                      <span>Download before this file’s expiry time.</span>
                    </div>
                  </>
                )
              )}
            </>
          )}
        </div>
      )}
      <footer className="app-footer">
        <span>Small fixes. Clear explanations. Your call.</span>
        <span>
          {local
            ? 'On your device · Background checks · Reversible changes'
            : 'Private uploads · Background checks · Reversible changes'}
        </span>
      </footer>
      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent className="settings-dialog">
          <DialogHeader>
            <DialogTitle>Review these {similar.length} changes</DialogTitle>
            <DialogDescription>
              Only these proposed corrections on the current page will be
              applied. Each value comes from its own evidence. Undo restores the
              whole batch.
            </DialogDescription>
          </DialogHeader>
          <div className="bulk-preview">
            {similar.map((f) => (
              <p key={f.id}>
                <b>Row {f.rowId}</b> ·{' '}
                {f.patch?.changes
                  .map(
                    (c) =>
                      `${summary?.headers[c.column]}: ${c.before || '(empty)'} → ${c.after}`,
                  )
                  .join('; ')}
              </p>
            ))}
          </div>
          <Button
            disabled={busy || exporting || !similar.length}
            onClick={() => {
              void task('bulk', {
                items: similar.map((f) => ({
                  id: f.id,
                  fingerprint: f.fingerprint,
                })),
                note,
              });
              setBulkOpen(false);
            }}
          >
            Approve these {similar.length} changes
          </Button>
        </DialogContent>
      </Dialog>
      <CheckSettings
        open={rulesOpen}
        onOpenChange={setRulesOpen}
        headers={summary?.headers ?? []}
        draft={draft}
        setDraft={setDraft}
        error={error}
        onSave={() => {
          try {
            const rules = {
              ...draft,
              categories: draft.categories.map((c) => c.trim()).filter(Boolean),
            };
            validateRules(rules, summary?.headers ?? []);
            if (!availableChecks(rules).length)
              throw new Error('Choose at least one check.');
            setRulesOpen(false);
            void task('check', { rules });
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Check these settings.');
          }
        }}
      />
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this file and its results?</DialogTitle>
            <DialogDescription>
              This removes the uploaded copy, suggestions, and decisions from
              this workspace. Download anything you want to keep first.
            </DialogDescription>
          </DialogHeader>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Keep file
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!job) return;
                try {
                  await request(`jobs/${job.id}`, 'DELETE');
                  setJob(null);
                  setDeleteOpen(false);
                  await refreshJobs();
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : 'Could not delete file.',
                  );
                }
              }}
            >
              Delete file
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
