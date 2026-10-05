import { h } from 'preact'

const React = { createElement: h }

export function GitMetadata({ session }) {
  const branch = session.current_branch
  const pullRequest = session.pull_request
  const pullRequestState = pullRequest?.draft ? 'Draft' : pullRequest?.state === 'open' ? 'Open' : null

  return <section class="git-metadata" aria-label="Git metadata">
    <article class="git-card branch-card">
      <div class="git-card-label">Branch</div>
      <div class="git-card-value"><code data-testid="git-branch">{branch || 'No current branch'}</code></div>
    </article>
    <article class="git-card pull-request-card">
      <div class="git-card-label">Pull request</div>
      <div class="git-card-value">{pullRequest ? <span class="pull-request-content">
        <a class="git-card-link" href={pullRequest.url} target="_blank" rel="noreferrer">
          <span>PR #{pullRequest.number}</span>{pullRequest.title && <span class="git-card-title">{pullRequest.title}</span>}<span aria-hidden="true">↗</span>
        </a>
        {pullRequestState && <span class={`pr-state pr-state-${pullRequestState.toLowerCase()}`}>{pullRequestState}</span>}
      </span> : <span class="git-card-empty">No pull request</span>}</div>
    </article>
  </section>
}
