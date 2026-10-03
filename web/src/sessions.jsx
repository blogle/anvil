import { h } from 'preact'
import { activities, error, filter, loading, navigate, selected, sessions, stateLabel, statusFor, visibleSessions } from './state.js'
import { Clock } from './clock.jsx'

const React = { createElement: h }

export const labels = [['all','All'], ['working','Working'], ['needs-input','Needs input'], ['ready-for-review','Ready for review'], ['done','Done'], ['problem','Problem']]

export function SessionsWorkspace() {
  const visible = visibleSessions.value
  return <section class="session-workspace" aria-label="Sessions workspace">
    <div class="sidebar-head"><div><div class="eyebrow">Operations</div><h1>Sessions</h1></div><span class="count">{sessions.value.length} total</span></div>
    <div class="filters" aria-label="Session filters">{labels.map(([key, label]) => <button key={key} data-filter={key} class={`filter ${filter.value === key ? 'selected' : ''}`} aria-pressed={filter.value === key} onClick={() => { filter.value = key }}>{label}</button>)}</div>
    {!loading.value && !error.value && visible.length > 0 && <div class="workspace-summary"><div><strong>{visible.length} {visible.length === 1 ? 'session' : 'sessions'}</strong><span>Live work across your projects</span></div></div>}
    <SessionList/>
  </section>
}

function SessionList() {
  return <div class="session-list">{loading.value ? <div class="loading">Loading sessions...</div> : error.value && !sessions.value.length ? <div class="error-card"><strong>Sessions unavailable</strong>{error.value}</div> : !visibleSessions.value.length ? <div class="empty"><strong>{filter.value === 'all' ? 'No sessions yet' : `No ${filter.value} sessions`}</strong><span>{filter.value === 'all' ? 'Anvil sessions will appear here when work is dispatched.' : 'No sessions match this filter.'}</span></div> : visibleSessions.value.map((session) => <SessionRow key={session.id} session={session}/>)}</div>
}

export function SessionRow({ session }) {
  const activity = activities.value.get(session.id), status = statusFor(activity)
  return <button class={`session-row ${selected.value === session.id ? 'selected' : ''}`} data-session={session.id} aria-current={selected.value === session.id ? 'true' : 'false'} onClick={() => navigate(session.id)}>
    <div class="session-title">{session.project || 'Anvil'} session</div><div class="session-meta"><span>{session.project}</span><span>·</span><span><code>{session.work_branch}</code></span></div>
    <div class={`session-state state-${status}`}><span class="status-dot"/><span class="session-status-label">{stateLabel(status)}</span><span class="row-detail">· <Clock value={activity?.work_state_changed_at}/></span></div>
  </button>
}
