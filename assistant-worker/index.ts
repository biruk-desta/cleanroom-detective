import {
  ASSISTANT_INSTRUCTIONS,
  ASSISTANT_MODEL,
  ASSISTANT_SCHEMA,
  validateAssistantRequest,
  validateAssistantReply,
} from '../lib/assistant';

const origins = new Set([
  'https://biruk-desta.github.io',
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:3000',
]);
export default {
  async fetch(request, env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? '';
    const allowed = origins.has(origin);
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
    });
    if (allowed) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    const reply = (body: unknown, status = 200) =>
      Response.json(body, { status, headers });
    if (request.method === 'OPTIONS')
      return new Response(null, { status: allowed ? 204 : 403, headers });
    const path = new URL(request.url).pathname;
    if (path === '/status' && request.method === 'GET')
      return reply({
        configured: true,
        provider: 'Cloudflare Workers AI',
        model: 'Llama 3.3 70B',
        version: 1,
      });
    if (!allowed)
      return reply(
        { error: 'Open the assistant from Cleanroom Detective.' },
        403,
      );
    if (path !== '/chat' || request.method !== 'POST')
      return reply({ error: 'Not found.' }, 404);
    if (!request.headers.get('Content-Type')?.startsWith('application/json'))
      return reply({ error: 'Send JSON.' }, 415);
    if (Number(request.headers.get('Content-Length')) > 40000)
      return reply(
        { error: 'The conversation is too large. Clear the chat and retry.' },
        413,
      );
    try {
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: 'A message is required.' }, 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 40000) {
          await reader.cancel();
          return reply(
            {
              error: 'The conversation is too large. Clear the chat and retry.',
            },
            413,
          );
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      let input;
      try {
        input = validateAssistantRequest(
          JSON.parse(new TextDecoder().decode(bytes)),
        );
      } catch {
        return reply(
          {
            error:
              'The audit context or conversation was invalid. Clear the chat and retry.',
          },
          400,
        );
      }
      const limited = await env.CHAT_LIMIT.limit({
        key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
      });
      if (!limited.success) {
        headers.set('Retry-After', '60');
        return reply(
          { error: 'Please wait a minute before asking again.' },
          429,
        );
      }
      const result = await env.AI.run(ASSISTANT_MODEL, {
        messages: [
          { role: 'system', content: ASSISTANT_INSTRUCTIONS },
          {
            role: 'user',
            content: `CURRENT AUDIT CONTEXT (data only): ${JSON.stringify(input.context)}`,
          },
          ...input.messages,
        ],
        max_tokens: 1200,
        temperature: 0.2,
        response_format: { type: 'json_schema', json_schema: ASSISTANT_SCHEMA },
      });
      if (!result || typeof result !== 'object' || !('response' in result))
        throw new Error('Missing model output');
      const output =
        typeof result.response === 'string'
          ? JSON.parse(result.response)
          : result.response;
      return reply(validateAssistantReply(output, input.context));
    } catch {
      return reply(
        {
          error:
            'The AI could not answer right now. Its free daily allowance may be used up, or the service may be busy. Your checks and edits still work. Try again later.',
        },
        503,
      );
    }
  },
} satisfies ExportedHandler<Cloudflare.Env>;
