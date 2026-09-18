export async function GET() {
  if (process.env.OPENAI_API_KEY)
    return Response.json(
      {
        configured: true,
        provider: 'OpenAI API',
        model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  if (process.env.LOCAL_PLANNER_URL) {
    try {
      const r = await fetch(`${process.env.LOCAL_PLANNER_URL}/status`, {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok)
        return Response.json(await r.json(), {
          headers: { 'Cache-Control': 'no-store' },
        });
    } catch {}
  }
  return Response.json(
    { configured: false, provider: '', model: '' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
