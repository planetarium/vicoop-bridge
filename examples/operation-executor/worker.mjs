// Process one approved work item. Schedule this host-side command as needed.
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export function runHandler(command, job, env = process.env) {
  return new Promise((resolve) => {
    const unknown = { state: 'unknown', result: 'Host execution requires reconciliation.' };
    const child = spawn(command, [], {
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      env,
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    let size = 0;
    const chunks = [];
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.once('error', () => resolve(unknown));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(job));
    child.once('close', (code) => {
      if (code !== 0 || size > 4096) return resolve(unknown);
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !['succeeded', 'failed', 'unknown'].includes(reply.state) ||
          typeof reply.result !== 'string' ||
          reply.result.length > 1024
        )
          return resolve(unknown);
        resolve({ state: reply.state, result: reply.result });
      } catch {
        resolve(unknown);
      }
    });
  });
}

export async function runOnce(env, fetcher = fetch, execute = runHandler) {
  const { BRIDGE_URL, AGENT_ID, OPERATION, OPERATION_VERSION, EXECUTOR_TOKEN, OPERATION_HANDLER } =
    env;
  if (
    !BRIDGE_URL ||
    !AGENT_ID ||
    !OPERATION ||
    !OPERATION_VERSION ||
    !EXECUTOR_TOKEN ||
    !OPERATION_HANDLER ||
    !isAbsolute(OPERATION_HANDLER)
  )
    throw Error('Set all worker parameters, including an absolute handler executable');
  const base = new URL(BRIDGE_URL);
  if (
    base.username ||
    base.password ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
  )
    throw Error('Invalid bridge origin');
  const path =
    '/operation-executors/' + encodeURIComponent(AGENT_ID) + '/' + encodeURIComponent(OPERATION);
  async function post(suffix, body) {
    const response = await fetcher(new URL(path + suffix, base), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + EXECUTOR_TOKEN, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw Error('Bridge request failed with HTTP ' + response.status);
    return response.json();
  }
  const { operation: job } = await post('/claim');
  if (!job) return;
  let outcome;
  if (
    job.operation !== OPERATION ||
    job.version !== OPERATION_VERSION ||
    job.state !== 'executing' ||
    !Number.isFinite(Date.parse(job.expiresAt)) ||
    Date.parse(job.expiresAt) <= Date.now()
  ) {
    outcome = { state: 'failed', result: 'Host rejected expired or incompatible operation.' };
  } else {
    const { EXECUTOR_TOKEN: _secret, ...handlerEnv } = env;
    outcome = await execute(OPERATION_HANDLER, job, handlerEnv);
  }
  // A lost result response can safely be reconciled by ID. Never invoke the
  // handler again for the same job, including when an upstream call timed out.
  await post('/' + encodeURIComponent(job.id) + '/result', outcome);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOnce(process.env).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
