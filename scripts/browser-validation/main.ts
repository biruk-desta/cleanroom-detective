import type { LargeJob, LargeFinding } from '../../lib/large-types';
import type { Row } from '../../lib/audit';
import { browserBackend as api } from '../../lib/browser-backend';
import { inferRules } from '../../lib/audit';
const status = document.querySelector('#status')!;
const log = (s: string) => {
  status.textContent += '\n' + s;
};
let activeId = '';
async function settled(id: string) {
  while (true) {
    const job = await api.request<LargeJob>(`jobs/${id}`);
    status.textContent =
      status.textContent!.split('\nProgress:')[0] +
      `\nProgress: ${job.phase} · ${job.records.toLocaleString()} rows`;
    if (!['working', 'queued'].includes(job.state)) {
      if (['failed', 'cancelled'].includes(job.state))
        throw Error(job.error || 'Task failed');
      return job;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
document.querySelector('#run')!.addEventListener('click', async () => {
  const button = document.querySelector('#run') as HTMLButtonElement;
  button.disabled = true;
  try {
    const started = Date.now();
    await api.request('session');
    log('Storage ' + JSON.stringify(await navigator.storage.estimate()));
    log('Jobs ' + JSON.stringify(await api.request('jobs')));
    const note = 'x'.repeat(950),
      line = `same,1,2.00,2.00,${note}\n`,
      header = 'id,quantity,unit_price,total,note\n',
      first = `first,?,2.00,2.00,${note}\n`;
    const count = 1200000,
      per = 8000;
    const size =
      new Blob([header, first]).size + (count - 1) * new Blob([line]).size;
    const job = await api.request<LargeJob>('jobs', 'POST', {
      name: 'browser-validation-large.csv',
      size,
    });
    activeId = job.id;
    log(`File: ${size} bytes; ${count} rows`);
    const signal = new AbortController().signal;
    let offset = 0;
    const initial = new Blob([header, first]);
    offset = (await api.writeChunk(job.id, offset, initial, signal)).offset;
    let remaining = count - 1;
    while (remaining) {
      const n = Math.min(per, remaining);
      const blob = new Blob([line.repeat(n)]);
      offset = (await api.writeChunk(job.id, offset, blob, signal)).offset;
      remaining -= n;
      status.textContent = `File: ${size} bytes; copying ${offset} bytes`;
    }
    log('Original copied. Importing…');
    await api.request(`jobs/${job.id}/finish`, 'POST');
    let done = await settled(job.id);
    if (done.summary?.sourceRecords !== count)
      throw Error('Row count mismatch');
    log('PASS all rows imported');
    const rules = {
      ...inferRules(done.summary!.headers),
      idColumn: '',
      outlierColumn: '',
      checkOutliers: false,
      arithmetic: true,
      missingTokens: ['', '?'],
    };
    await api.request(`jobs/${job.id}/check`, 'POST', { rules });
    done = await settled(job.id);
    const findings = await api.request<LargeFinding[]>(
      `jobs/${job.id}/findings`,
    );
    if (findings.length !== 1 || findings[0].patch?.changes[0].after !== '1')
      throw Error('Expected one exact repair');
    log('PASS exact whole-file audit: one repair');
    await api.request(`jobs/${job.id}/decide`, 'POST', {
      id: findings[0].id,
      fingerprint: findings[0].fingerprint,
      action: 'apply',
    });
    done = await settled(job.id);
    let rows = await api.request<Row[]>(`jobs/${job.id}/rows`);
    if (rows[0].cells[1] !== '1' || done.summary?.applied !== 1)
      throw Error('Repair failed');
    log('PASS approved repair');
    await api.request(`jobs/${job.id}/undo`, 'POST');
    done = await settled(job.id);
    rows = await api.request<Row[]>(`jobs/${job.id}/rows`);
    if (rows[0].cells[1] !== '?' || done.summary?.applied !== 0)
      throw Error('Undo failed');
    log(
      `PASS undo. COMPLETE ${size} bytes, ${count} rows in ${((Date.now() - started) / 1000).toFixed(1)} seconds.`,
    );
  } catch (e) {
    log('FAIL ' + (e as Error).stack);
  } finally {
    button.disabled = false;
  }
});
document.querySelector('#clean')!.addEventListener('click', async () => {
  if (activeId) {
    await api.request(`jobs/${activeId}`, 'DELETE');
    log('Test data deleted.');
  }
});
