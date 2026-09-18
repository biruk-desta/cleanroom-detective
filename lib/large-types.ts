import type { Rules, Finding } from './audit';
export type LargeSummary = {
  headers: string[];
  rules: Rules;
  checked: boolean;
  name: string;
  sourceRecords: number;
  records: number;
  pending: number;
  repairs: number;
  decisions: number;
  applied: number;
  kept: number;
};
export type LargeJob = {
  id: string;
  name: string;
  size: number;
  offset: number;
  state:
    | 'uploading'
    | 'queued'
    | 'working'
    | 'ready'
    | 'complete'
    | 'failed'
    | 'cancelled';
  phase: string;
  task: string;
  error: string | null;
  created: number;
  expires: number;
  records: number;
  progress: number;
  summary: LargeSummary | null;
};
export type LargeFinding = Finding & { fingerprint: string; reviewed: boolean };
export type LargeSession = {
  username: string;
  maxUploadBytes: number;
  chunkBytes: number;
  retentionHours: number;
};
