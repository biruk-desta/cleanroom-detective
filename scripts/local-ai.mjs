import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
const checks = [
  'duplicates',
  'arithmetic',
  'dates',
  'categories',
  'units',
  'outliers',
];
const schema = {
  type: 'object',
  properties: {
    next: { type: 'string', enum: [...checks, 'finish'] },
    reason: { type: 'string' },
  },
  required: ['next', 'reason'],
  additionalProperties: false,
};
const instructions =
  'You are a CSV audit investigator. Given numeric statistics with opaque column IDs and completed check counts, select the next available check. Never repeat a completed check. Choose finish only after all available checks ran. Explain your choice in one short sentence without claiming unseen findings. Do not use any tools, read files, browse or execute commands. Return the requested JSON. Input follows:\n';
async function findCodex() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const directory of (process.env.PATH || '').split(separator)) {
    if (directory && existsSync(join(directory, executable)))
      return join(directory, executable);
  }
  const extensions = join(homedir(), '.vscode', 'extensions');
  try {
    const names = (await readdir(extensions))
      .filter((name) => name.startsWith('openai.chatgpt-'))
      .sort()
      .reverse();
    const platform = process.platform === 'darwin' ? 'macos' : process.platform;
    const architecture = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
    for (const name of names) {
      const candidate = join(
        extensions,
        name,
        'bin',
        `${platform}-${architecture}`,
        executable,
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return executable;
}
const bin = await findCodex();
const cwd = await mkdtemp(join(tmpdir(), 'cleanroom-planner-'));
const schemaPath = join(cwd, 'schema.json');
await writeFile(schemaPath, JSON.stringify(schema));
let running = false,
  activeChild;
function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const force = setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 2000);
  force.unref();
}
function numeric(n) {
  return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e300;
}
function sanitize(v) {
  if (
    !v ||
    !Number.isInteger(v.records) ||
    v.records < 1 ||
    v.records > 5000 ||
    !Array.isArray(v.columns) ||
    v.columns.length > 40 ||
    !Array.isArray(v.available) ||
    !Array.isArray(v.completed)
  )
    throw new Error('Invalid bounded statistics');
  return {
    records: v.records,
    columns: v.columns.map((c) => {
      if (
        ![c.id, c.missing, c.distinct, c.numeric].every(
          (n) => Number.isInteger(n) && n >= 0 && n <= 5000,
        ) ||
        ![c.min, c.max].every((n) => n === null || numeric(n))
      )
        throw new Error('Invalid numeric profile');
      return {
        id: c.id,
        missing: c.missing,
        distinct: c.distinct,
        numeric: c.numeric,
        min: c.min,
        max: c.max,
      };
    }),
    available: v.available.map((c) => {
      if (!checks.includes(c)) throw new Error('Unknown check');
      return c;
    }),
    completed: v.completed.map((c) => {
      if (
        !checks.includes(c.check) ||
        ![c.repairs, c.issues, c.reviews].every(
          (n) => Number.isInteger(n) && n >= 0 && n <= 15000,
        )
      )
        throw new Error('Invalid check counts');
      return {
        check: c.check,
        repairs: c.repairs,
        issues: c.issues,
        reviews: c.reviews,
      };
    }),
  };
}
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.origin) {
    res.writeHead(403);
    res.end(
      JSON.stringify({ error: 'Direct browser calls are not accepted.' }),
    );
    return;
  }
  if (req.url === '/status' && req.method === 'GET') {
    res.end(
      JSON.stringify({
        configured: true,
        provider: 'Local Codex · ChatGPT sign-in',
        model: 'Codex default',
      }),
    );
    return;
  }
  if (req.url !== '/plan' || req.method !== 'POST') {
    res.writeHead(404);
    res.end('{}');
    return;
  }
  if (running) {
    res.writeHead(409);
    res.end(
      JSON.stringify({ error: 'Another local investigation is running.' }),
    );
    return;
  }
  let input;
  try {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 24000) throw new Error('Request too large');
    }
    input = sanitize(JSON.parse(raw));
  } catch (e) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: e.message }));
    return;
  }
  if (running) {
    res.writeHead(409);
    res.end(
      JSON.stringify({ error: 'Another local investigation is running.' }),
    );
    return;
  }
  running = true;
  const args = [
    'exec',
    '--ignore-user-config',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--cd',
    cwd,
    '--output-schema',
    schemaPath,
    '--color',
    'never',
    '--disable',
    'shell_tool',
    '--disable',
    'unified_exec',
    '--disable',
    'apps',
    '--disable',
    'multi_agent',
    '--disable',
    'hooks',
    '--disable',
    'remote_plugin',
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.view_image=false',
    '-',
  ];
  const child = spawn(bin, args, {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeChild = child;
  let out = '',
    stderr = '';
  const timer = setTimeout(() => terminate(child), 110000);
  child.stdout.on('data', (d) => {
    out += d;
    if (out.length > 20000) terminate(child);
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 100000) terminate(child);
  });
  child.stdin.on('error', () => {});
  child.stdin.end(instructions + JSON.stringify(input));
  let closed = false;
  const finish = (status, body) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    running = false;
    activeChild = undefined;
    if (!res.destroyed) {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    }
  };
  child.on('error', () =>
    finish(503, {
      error: 'Codex CLI could not start. Check CODEX_BIN and codex login.',
    }),
  );
  res.on('close', () => {
    if (!res.writableEnded) terminate(child);
  });
  child.on('close', (code) => {
    if (code !== 0)
      return finish(503, {
        error:
          'The local model call failed or timed out. Check codex login status and try again.',
      });
    try {
      const value = JSON.parse(out.trim());
      if (
        ![...checks, 'finish'].includes(value.next) ||
        typeof value.reason !== 'string' ||
        value.reason.length > 1000
      )
        throw new Error();
      finish(200, value);
    } catch {
      finish(502, { error: 'The model returned an invalid plan.' });
    }
  });
});
server.listen(8788, '127.0.0.1', () =>
  console.log(
    'Local AI planner ready at http://127.0.0.1:8788 (numeric statistics only)',
  ),
);
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, () => {
    server.close();
    terminate(activeChild);
    rm(cwd, { recursive: true, force: true }).finally(() => {
      const exit = setTimeout(() => process.exit(), 2200);
      exit.unref();
    });
  });
