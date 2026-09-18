import {
  parseCSV,
  validateRules,
  inspectCheck,
  type Trace,
  type Finding,
  type Check,
} from '@/lib/audit';
import {
  plannerInput,
  validatePlan,
  PLAN_SCHEMA,
  PLANNER_INSTRUCTIONS,
  type PlannerInput,
} from '@/lib/planner';
async function plan(input: PlannerInput, signal: AbortSignal) {
  if (process.env.OPENAI_API_KEY) {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5-mini',
        instructions: PLANNER_INSTRUCTIONS,
        input: JSON.stringify(input),
        store: false,
        reasoning: { effort: 'low' },
        max_output_tokens: 1500,
        text: {
          format: {
            type: 'json_schema',
            name: 'audit_plan',
            strict: true,
            schema: PLAN_SCHEMA,
          },
        },
      }),
      signal,
    });
    if (!r.ok)
      throw new Error(
        `Model service returned ${r.status}. Check the server-side connection and retry.`,
      );
    const body = (await r.json()) as {
      status?: string;
      output?: { content?: { type: string; text?: string }[] }[];
    };
    if (body.status !== 'completed')
      throw new Error(
        'Model response was incomplete. Retry the investigation.',
      );
    const text = body.output
      ?.flatMap(
        (o: { content?: { type: string; text?: string }[] }) => o.content ?? [],
      )
      .filter((c: { type: string }) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('');
    return validatePlan(JSON.parse(text || 'null'), input);
  }
  if (process.env.LOCAL_PLANNER_URL) {
    const r = await fetch(`${process.env.LOCAL_PLANNER_URL}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal,
    });
    const body = (await r.json()) as { error?: string };
    if (!r.ok) throw new Error(body.error || 'Local planner unavailable.');
    return validatePlan(body, input);
  }
  throw new Error(
    'No live model connection is configured. You can run the rules audit instead.',
  );
}
export async function POST(request: Request) {
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return Response.json(
      { error: 'Cross-origin requests are not accepted.' },
      { status: 403 },
    );
  let data, rules;
  try {
    const text = await request.text();
    if (text.length > 2_000_000) throw new Error('Request too large.');
    const body = JSON.parse(text);
    if (typeof body.csv !== 'string' || typeof body.name !== 'string')
      throw new Error('CSV and name are required.');
    data = parseCSV(body.csv, body.name);
    rules = validateRules(body.rules, data.headers);
    if (
      !Array.isArray(body.rowIds) ||
      body.rowIds.length !== data.rows.length ||
      new Set(body.rowIds).size !== body.rowIds.length ||
      body.rowIds.some(
        (x: unknown) =>
          !Number.isSafeInteger(x) || Number(x) < 1 || Number(x) > 5000,
      )
    )
      throw new Error('Invalid stable record IDs.');
    data.rows = data.rows.map((r, i) => ({ ...r, id: body.rowIds[i] }));
    if (!plannerInput(data, rules, []).available.length)
      throw new Error('Configure at least one check.');
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : 'Invalid request.' },
      { status: 400 },
    );
  }
  if (!process.env.OPENAI_API_KEY && !process.env.LOCAL_PLANNER_URL)
    return Response.json(
      { error: 'No model connection configured. Run the rules audit.' },
      { status: 503 },
    );
  const encoder = new TextEncoder();
  const lifecycle = new AbortController();
  const signal = AbortSignal.any([request.signal, lifecycle.signal]);
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      const completed: { check: Check; findings: Finding[] }[] = [];
      let findings: Finding[] = [];
      let step = 0;
      const trace = (tool: string, summary: string, n = 0) =>
        send({
          type: 'trace',
          trace: {
            step: ++step,
            tool,
            summary,
            findings: n,
            at: new Date().toISOString(),
          } satisfies Trace,
        });
      try {
        trace(
          'profile_dataset',
          `Measured ${data.rows.length} records and ${data.headers.length} columns. Only numeric statistics are sent to the model.`,
        );
        const count = plannerInput(data, rules, []).available.length;
        for (let i = 0; i < count; i++) {
          if (signal.aborted) throw new Error('Investigation cancelled.');
          const input = plannerInput(data, rules, completed);
          const choice = await plan(
            input,
            AbortSignal.any([signal, AbortSignal.timeout(115000)]),
          );
          if (choice.next === 'finish') break;
          trace('model_choose_check', choice.reason);
          const measured = inspectCheck(data, rules, choice.next);
          completed.push({ check: choice.next, findings: measured });
          findings = [...findings, ...measured];
          trace(
            choice.next,
            `Executed ${choice.next}: ${measured.length} findings from the working records.`,
            measured.length,
          );
          send({ type: 'findings', findings });
        }
        const remaining = plannerInput(data, rules, completed).available.filter(
          (c) => !completed.some((x) => x.check === c),
        );
        if (remaining.length)
          throw new Error(
            'Investigation ended before every configured check ran.',
          );
        send({
          type: 'done',
          findings,
          summary: `AI selected the order of ${completed.length} checks using measured profiles and prior results. Deterministic tools found ${findings.filter((f) => f.kind === 'repair').length} supported repairs and ${findings.filter((f) => f.kind !== 'repair').length} items requiring source evidence or human judgment. No values were changed automatically.`,
        });
      } catch (e) {
        try {
          send({
            type: 'error',
            error: e instanceof Error ? e.message : 'Investigation failed.',
          });
        } catch {}
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      lifecycle.abort();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
