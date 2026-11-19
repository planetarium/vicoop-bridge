#!/usr/bin/env node
// Example trusted handler. Only the repository selected by this host is allowed.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const job = JSON.parse(input);
const { repository, pull, head } = job.arguments;
function finish(state, result) {
  console.log(JSON.stringify({ state, result }));
}
if (
  job.operation !== 'merge-pr' ||
  job.version !== '1' ||
  repository !== process.env.GITHUB_REPOSITORY ||
  !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
  !Number.isSafeInteger(pull) ||
  pull < 1 ||
  !/^[a-f0-9]{40}$/.test(head) ||
  !process.env.GITHUB_TOKEN ||
  Date.parse(job.expiresAt) <= Date.now()
) {
  finish('failed', 'Rejected repository, PR, credential configuration or head precondition.');
} else {
  try {
    // GitHub checks the expected head SHA atomically with the merge.
    const response = await fetch(
      'https://api.github.com/repos/' + repository + '/pulls/' + pull + '/merge',
      {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({ sha: head, merge_method: 'merge' }),
      },
    );
    if (response.ok && (await response.json()).merged === true)
      finish('succeeded', 'Pull request merged.');
    else if ([403, 404, 405, 409, 422].includes(response.status))
      finish('failed', 'GitHub rejected the merge or its precondition.');
    else finish('unknown', 'Inspect the pull request to reconcile the merge outcome.');
  } catch {
    finish('unknown', 'Inspect the pull request to reconcile the merge outcome.');
  }
}
