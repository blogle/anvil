import { h } from 'preact'
import {
  activities, environmentFilter, environmentFor, environmentOptions, error, executionFilter,
  executionFor, executionOptions, loading, navigate, search, selected, sessions, visibleSessions,
} from './state.js'
import { Clock } from './clock.jsx'

const React = { createElement: h }

export function SessionsWorkspace() {
  const visible = visibleSessions.value
  return <section class="session-workspace" aria-label="Sessions workspace">
    <div class="sidebar-head"><div><div class="eyebrow">Operations</div><h1>Sessions</h1></div><span class="count">{sessions.value.length} total</span></div>
    <div class="filters" aria-label="Session filters">
      <label for="session-search">Search sessions</label>
      <input id="session-search" type="search" data-filter="search" placeholder="Project, name, ID, repository, ref…" value={search.value} onInput={(event) => { search.value = event.currentTarget.value }}/>
      <label for="environment-filter">Environment / Runtime</label>
      <select id="environment-filter" data-filter="environment" value={environmentFilter.value} onChange={(event) => { environmentFilter.value = event.currentTarget.value }}>
        <option value="">All</option>{environmentOptions.value.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <label for="execution-filter">OpenCode / Execution</label>
      <select id="execution-filter" data-filter="execution" value={executionFilter.value} onChange={(event) => { executionFilter.value = event.currentTarget.value }}>
        <option value="">All</option>{executionOptions.value.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </div>
    {!loading.value && !error.value && visible.length > 0 && <div class="workspace-summary"><div><strong>{visible.length} {visible.length === 1 ? 'session' : 'sessions'}</strong><span>Live work across your projects</span></div></div>}
    <SessionList/>
  </section>
}

function SessionList() {
  const hasSessions = sessions.value.length > 0
  return <div class="session-list">{loading.value ? <div class="loading">Loading sessions...</div> : error.value && !hasSessions ? <div class="error-card"><strong>Sessions unavailable</strong>{error.value}</div> : !visibleSessions.value.length ? <div class="empty"><strong>{hasSessions ? 'No matching sessions' : 'No sessions yet'}</strong><span>{hasSessions ? 'No sessions match the current search and runtime filters.' : 'Anvil sessions will appear here when work is dispatched.'}</span></div> : visibleSessions.value.map((session) => <SessionRow key={session.id} session={session}/>)}</div>
}

export function SessionRow({ session }) {
  const activity = activities.value.get(session.id)
  return <button class={`session-row ${selected.value === session.id ? 'selected' : ''}`} data-session={session.id} aria-current={selected.value === session.id ? 'true' : 'false'} onClick={() => navigate(session.id)}>
    <div class="session-title">{session.project || 'Anvil'} session</div><div class="session-meta"><span>{session.project}</span><span>·</span><span><code>{session.work_branch}</code></span></div>
    <div class="session-state factual-state"><span>Environment: <code>{environmentFor(session, activity)}</code></span><span>Execution: <code>{executionFor(session, activity)}</code></span></div>
  </button>
}
