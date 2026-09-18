import {
  allFindings,
  type Dataset,
  type Decision,
  type Rules,
  type Trace,
} from './audit';
const esc = (s: unknown) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export function reportHTML(
  original: Dataset,
  data: Dataset,
  rules: Rules,
  decisions: Decision[],
  traces: Trace[],
  summary: string,
) {
  const remaining = allFindings(data, rules);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Cleanroom Detective audit report</title><style>body{font:16px/1.6 system-ui;max-width:920px;margin:50px auto;padding:24px;color:#19313d}h1,h2{line-height:1.2}article{border:1px solid #dae3e8;border-radius:10px;padding:18px;margin:15px 0}small{color:#576b75}pre{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:6px 0}@media print{article{break-inside:avoid}}</style><h1>Cleanroom Detective</h1><p>Evidence-led audit · ${esc(original.name)} · ${esc(new Date().toISOString())}</p><p>${original.rows.length} source records → ${data.rows.length} working records. ${decisions.filter((d) => d.action === 'apply').length} approved repairs; ${decisions.filter((d) => d.action === 'keep').length} decisions to retain values. The original file is preserved separately.</p><h2>Investigation summary</h2><p>${esc(summary || 'Deterministic audit; no model summary generated.')}</p><h2>Decision ledger</h2>${decisions.map((d) => `<article><h3>Record ${d.finding.rowId} · ${esc(d.finding.title)}</h3><p>${d.action === 'apply' ? 'Applied approved change' : 'Kept unchanged'} · ${esc(d.at)}</p><pre>${esc(JSON.stringify(d.finding.patch ?? {}, null, 2))}</pre><ul>${d.finding.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul><p>Reviewer: ${esc(d.note || 'Approved the evidence-backed proposal.')}</p></article>`).join('') || '<p>No decisions recorded.</p>'}<h2>Findings still present</h2><p>Includes retained values and review requests. Unusual values are not proof of defects.</p>${remaining.map((f) => `<article><strong>Record ${f.rowId} · ${esc(f.title)}</strong><p>${esc(f.detail)}</p><ul>${f.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></article>`).join('') || '<p>No findings from the configured checks.</p>'}<h2>Executed checks</h2><ol>${traces.map((t) => `<li><b>${esc(t.tool)}</b> — ${esc(t.summary)} <small>${esc(t.at)}</small></li>`).join('')}</ol><h2>Confirmed rules</h2><pre>${esc(JSON.stringify(rules, null, 2))}</pre><p><small>Prototype limits: 1 MB, 5,000 records, 40 columns. Conclusions cover only the configured checks. The bundled practice case is synthetic, not a blind benchmark.</small></p></html>`;
}
