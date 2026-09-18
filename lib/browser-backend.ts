import type { LargeJob, LargeSession } from './large-types';
export type LargeBackend = {
  mode: 'browser';
  request<T>(
    this: void,
    path: string,
    method?: string,
    body?: unknown,
  ): Promise<T>;
  writeChunk(
    id: string,
    offset: number,
    chunk: Blob,
    signal: AbortSignal,
  ): Promise<{ offset: number }>;
  download(id: string, kind: string, filename: string): Promise<void>;
};
type SaveWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<FileSystemFileHandle>;
};
let worker: Worker | null = null,
  boot: Promise<void> | null = null;
let fatal: Error | null = null;
let sequence = 0,
  session: LargeSession;
const jobs = new Map<string, LargeJob>();
const calls = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
function call<T>(type: string, args: unknown): Promise<T> {
  if (fatal) return Promise.reject(fatal);
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    calls.set(id, { resolve: (value) => resolve(value as T), reject });
    worker!.postMessage({ id, type, args });
  });
}
function start(cancelId?: string) {
  if (boot) return boot;
  boot = (async () => {
    if (!(window as SaveWindow).showSaveFilePicker)
      throw new Error(
        'For large files, open this website in desktop Chrome or Edge. You can still use the café example and small CSVs here.',
      );
    worker = new Worker(new URL('./browser-worker.mjs', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = ({ data }) => {
      if (data.event === 'job') {
        jobs.set(data.job.id, data.job as LargeJob);
        return;
      }
      if (data.event === 'removed') {
        jobs.delete(data.id);
        return;
      }
      const pending = calls.get(data.id);
      if (!pending) return;
      calls.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.result);
    };
    worker.onerror = () => {
      const error = new Error(
        'The browser processor stopped. Reload this page and retry your file.',
      );
      fatal = error;
      for (const pending of calls.values()) pending.reject(error);
      calls.clear();
    };
    const value = await call<{ session: LargeSession; jobs: LargeJob[] }>(
      'init',
      { cancelId },
    );
    session = value.session;
    jobs.clear();
    value.jobs.forEach((j) => jobs.set(j.id, j));
  })().catch((error) => {
    worker?.terminate();
    fatal = error;
    throw error;
  });
  return boot;
}
export const browserBackend: LargeBackend = {
  mode: 'browser',
  async request<T>(
    this: void,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    await start();
    if (fatal) throw fatal;
    if (path === 'session') return session as T;
    const cancel = /^jobs\/([a-f0-9-]+)\/cancel$/.exec(path);
    if (cancel) {
      worker?.terminate();
      worker = null;
      boot = null;
      for (const pending of calls.values())
        pending.reject(new Error('Task stopped.'));
      calls.clear();
      await start(cancel[1]);
      return jobs.get(cancel[1]) as T;
    }
    const busy = [...jobs.values()].some((j) =>
      ['working', 'queued'].includes(j.state),
    );
    if (busy && method === 'GET') {
      if (path === 'jobs') return [...jobs.values()] as T;
      const match = /^jobs\/([a-f0-9-]+)$/.exec(path);
      if (match && jobs.has(match[1])) return jobs.get(match[1]) as T;
    }
    return call<T>('request', [path, method, body]);
  },
  async writeChunk(id, offset, chunk, signal) {
    if (signal.aborted) throw new DOMException('Paused', 'AbortError');
    await start();
    return call('chunk', [id, offset, chunk]);
  },
  async download(id, kind, filename) {
    // Invoke this directly from the click: saving a file needs a user gesture.
    const handle = await (window as SaveWindow).showSaveFilePicker!({
      suggestedName: filename,
    });
    await start();
    await call('download', [id, kind, handle]);
  },
};
