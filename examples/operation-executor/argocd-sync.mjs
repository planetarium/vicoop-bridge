#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

// This operation submits a sync to a dedicated single-source Git Application.
// Configure its project/RBAC to fix the permitted source and destination. The
// Argo CD ApplicationService sync RPC accepts a revision, not a resourceVersion.
export async function submitSync(job, env, request = fetch) {
  const refused = { state: 'failed', result: 'Argo CD sync preconditions were not met.' };
  const uncertain = { state: 'unknown', result: 'Check the application sync history before taking further action.' };
  const { application, namespace, project, revision } = job.arguments ?? {};
  const dnsLabel = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
  if (job.operation !== 'argocd-sync' || job.version !== '1' || job.state !== 'executing' ||
      application !== env.ARGOCD_APPLICATION || namespace !== env.ARGOCD_NAMESPACE || project !== env.ARGOCD_PROJECT ||
      ![application, namespace, project].every(value => typeof value === 'string' && dnsLabel.test(value)) ||
      !/^[a-f0-9]{40}$/.test(revision) || !env.ARGOCD_TOKEN || !env.ARGOCD_REPOSITORY ||
      !Number.isFinite(Date.parse(job.expiresAt)) || Date.parse(job.expiresAt) <= Date.now()) return refused;

  const origin = URL.parse(env.ARGOCD_URL);
  if (!origin || origin.protocol !== 'https:' || origin.username || origin.password ||
      origin.pathname !== '/' || origin.search || origin.hash) return refused;
  const endpoint = new URL('/api/v1/applications/' + application, origin);
  const getUrl = new URL(endpoint);
  getUrl.searchParams.set('appNamespace', namespace);
  getUrl.searchParams.set('project', project);
  const headers = { Authorization: 'Bearer ' + env.ARGOCD_TOKEN, 'Content-Type': 'application/json' };
  const options = { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) };

  try {
    const before = await request(getUrl, options);
    if (!before.ok) return refused;
    const app = await before.json();
    if (app.metadata?.name !== application || app.metadata.namespace !== namespace || app.metadata.deletionTimestamp ||
        app.spec?.project !== project || app.spec.source?.repoURL !== env.ARGOCD_REPOSITORY ||
        app.spec.source.chart || app.spec.sources?.length || app.operation || Date.parse(job.expiresAt) <= Date.now()) return refused;
  } catch {
    return refused;
  }
  try {
    const response = await request(new URL(endpoint.pathname + '/sync', origin), {
      ...options, method: 'POST',
      body: JSON.stringify({ name: application, appNamespace: namespace, project, revision, prune: false }),
    });
    if ([400, 401, 403, 404, 409, 422].includes(response.status)) return refused;
    if (response.ok && (await response.json()).operation?.sync?.revision === revision) {
      return { state: 'succeeded', result: 'Argo CD accepted the sync request for revision ' + revision + '.' };
    }
    return uncertain;
  } catch {
    return uncertain;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  console.log(JSON.stringify(await submitSync(JSON.parse(input), process.env)));
}
