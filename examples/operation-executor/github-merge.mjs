#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export async function mergePull(job, env, request = fetch) {
  const { repository, pull, base, head } = job.arguments ?? {};
  const refused = { state: 'failed', result: 'GitHub merge preconditions were not met.' };
  const uncertain = {
    state: 'unknown',
    result: 'Inspect the pull request to reconcile the merge outcome.',
  };
  const expires = Date.parse(job.expiresAt);
  if (
    job.operation !== 'merge-pr' ||
    job.version !== '1' ||
    job.state !== 'executing' ||
    typeof repository !== 'string' ||
    repository !== env.GITHUB_REPOSITORY ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    typeof base !== 'string' ||
    !base ||
    base !== env.GITHUB_BASE_BRANCH ||
    !Number.isSafeInteger(pull) ||
    pull < 1 ||
    !/^[a-f0-9]{40}$/.test(head) ||
    !env.GITHUB_TOKEN ||
    !Number.isFinite(expires) ||
    expires <= Date.now()
  )
    return refused;

  const url = 'https://api.github.com/repos/' + repository + '/pulls/' + pull;
  const options = {
    headers: {
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  };
  try {
    const before = await request(url, options);
    if (!before.ok) return refused;
    const pr = await before.json();
    if (
      pr.state !== 'open' ||
      pr.number !== pull ||
      pr.base?.repo?.full_name !== repository ||
      pr.base.ref !== base ||
      pr.head?.sha !== head ||
      expires <= Date.now()
    )
      return refused;
  } catch {
    return refused;
  }

  try {
    // GitHub atomically checks only the head here. Repository rules must
    // restrict this credential to merging into the configured base branch.
    const response = await request(url + '/merge', {
      ...options,
      method: 'PUT',
      body: JSON.stringify({ sha: head, merge_method: 'merge' }),
    });
    if (response.ok && (await response.json()).merged === true)
      return { state: 'succeeded', result: 'Pull request merged.' };
    if ([401, 403, 404, 405, 409, 422].includes(response.status)) return refused;
    return uncertain;
  } catch {
    return uncertain;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  console.log(JSON.stringify(await mergePull(JSON.parse(input), process.env)));
}
