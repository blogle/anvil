import { h, render } from 'preact'
import { useEffect } from 'preact/hooks'
import { signal } from '@preact/signals'
import { activities, api, elapsed, error, filter, formatClock, formatDate, loading, navigate, refresh, relativeTime, routeFromHash, selected, sessionUI, sessions, stateLabel, statusFor, timestamp, visibleSessions } from './state.js'

const React = { createElement: h }

const labels = [['all','All'], ['working','Working'], ['needs-input','Needs input'], ['ready-for-review','Ready for review'], ['done','Done'], ['problem','Problem']]
const now = signal(Date.now())

function Clock({ value, relative = false, end }) {
  const time = now.value
  return relative ? `Last activity ${relativeTime(value, time)}` : elapsed(value, end ? timestamp(end)?.getTime() || time : time)
}

export function AppShell() {
  useEffect(() => {
    const route = () => { selected.value = routeFromHash() }
    window.addEventListener('hashchange', route); window.addEventListener('popstate', route)
    const visibility = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', visibility)
    refresh(); const timer = setInterval(refresh, 4000)
    const clock = setInterval(() => { if (document.visibilityState === 'visible') now.value = Date.now() }, 1000)
    return () => { window.removeEventListener('hashchange', route); window.removeEventListener('popstate', route); document.removeEventListener('visibilitychange', visibility); clearInterval(timer); clearInterval(clock) }
  }, [])
  return <div class={`app-shell ${selected.value ? 'mobile-detail' : ''}`}>
    <header class="topbar"><a class="brand" href={location.pathname} aria-label="Anvil Sessions"><svg class="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 17.5h18M5.4 17.5l2.2-6.2h8.7l2.3 6.2M7.2 11.3V8.2h9.6v3.1M4.8 8.2h14.4M10.1 8.2V5.3h3.8v2.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Anvil</span></a><nav class="nav" aria-label="Primary"><a class="active" href={location.pathname}>Sessions</a></nav><div class="topbar-status"><span class="status-dot"/>Control plane connected</div></header>
    <main class="workspace"><SessionsWorkspace/><SessionDetail/></main>
  </div>
}

function SessionsWorkspace() {
  return <aside class="sidebar" aria-label="Sessions"><div class="sidebar-head"><h1>Sessions</h1><span class="count">{sessions.value.length} total</span></div>
    <div class="filters" aria-label="Session filters">{labels.map(([key, label]) => <button key={key} data-filter={key} class={`filter ${filter.value === key ? 'selected' : ''}`} aria-pressed={filter.value === key} onClick={() => { filter.value = key; if (selected.value && !visibleSessions.value.some((item) => item.id === selected.value)) navigate(null, false) }}>{label}</button>)}</div>
    <SessionList/>
  </aside>
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

export function SessionDetail() {
  const id = selected.value
  const session = sessions.value.find((item) => item.id === id)
  const activity = activities.value.get(id)
  if (!id) return <section class="detail"><div class="detail-inner"><div class="empty"><strong>Select a session</strong>Choose a session to inspect its lifecycle and requests.</div></div></section>
  if (!session) return <section class="detail"><div class="detail-inner"><div class="loading">Loading session...</div></div></section>
  return <section class="detail" key={id}><DetailContent session={session} activity={activity}/></section>
}

function DetailContent({ session, activity }) {
  const ui = sessionUI(session.id)
  const status = statusFor(activity)
  return <div class="detail-inner"><a class="back-link" href={location.pathname} onClick={(event) => { event.preventDefault(); navigate(null) }}>All sessions</a>
    <div class="detail-header"><div><div class="eyebrow">Session overview</div><h2>{session.project || 'Anvil'} session</h2><div class="detail-subtitle"><span>{session.project}</span><span>·</span><code>{session.work_branch}</code></div><div class={`detail-status state-${status}`}><span class="status-dot"/><strong>{stateLabel(status)}</strong>{activity?.work_state_changed_at && <span>· <Clock value={activity.work_state_changed_at}/></span>}</div></div></div>
    {activity?.work_state_summary && <div class="work-summary"><div class="eyebrow">Work summary</div>{activity.work_state_summary}</div>}
    <SessionActions session={session} activity={activity} ui={ui}/>
    <div class="tabs" role="tablist" aria-label="Session detail"><button id="logs-tab" class={`tab ${ui.tab.value === 'logs' ? 'active' : ''}`} role="tab" aria-selected={ui.tab.value === 'logs'} tabIndex={ui.tab.value === 'logs' ? 0 : -1} aria-controls="logs-panel" onClick={() => ui.tab.value = 'logs'}>Logs</button><button id="runtime-tab" class={`tab ${ui.tab.value === 'runtime' ? 'active' : ''}`} role="tab" aria-selected={ui.tab.value === 'runtime'} tabIndex={ui.tab.value === 'runtime' ? 0 : -1} aria-controls="runtime-panel" onClick={() => ui.tab.value = 'runtime'}>Runtime</button></div>
    <div id="logs-panel" role="tabpanel" tabIndex="0" aria-labelledby="logs-tab" hidden={ui.tab.value !== 'logs'}><Logs activity={activity} ui={ui}/></div><div id="runtime-panel" role="tabpanel" tabIndex="0" aria-labelledby="runtime-tab" hidden={ui.tab.value !== 'runtime'}><Runtime activity={activity} session={session}/></div>
  </div>
}

function SessionActions({ session, activity, ui }) {
  const attachCommand = activity?.attach_command || `anvilctl sessions attach ${session.id}`
  const perform = async (path, method, message) => { if (!confirm(message)) return; try { await api(path, { method }); await refresh() } catch (cause) { alert(cause.message) } }
  return <div class="actions">{activity?.preview_url && <a class="button primary" href={activity.preview_url} target="_blank" rel="noreferrer">Open Preview</a>}{activity?.opencode_url && <a class="button" href={activity.opencode_url} target="_blank" rel="noreferrer">Open in OpenCode</a>}{activity?.work_state === 'ready_for_review' && <button class="button primary" onClick={() => perform(`/v1/sessions/${encodeURIComponent(session.id)}/complete`, 'POST', 'Accept this work and mark the session complete?')}>Accept and complete</button>}
    <div class="attach"><details open={ui.attachOpen.value} onToggle={(event) => ui.attachOpen.value = event.currentTarget.open}><summary class="button">Attach <span aria-hidden="true">⌄</span></summary><div class="attach-menu"><p>Run this command from a terminal with Anvil access.</p><code class="command">{attachCommand}</code><button class="button" style="margin-top:9px" onClick={async () => { try { await navigator.clipboard?.writeText(attachCommand); ui.copyStatus.value = 'Copied' } catch { ui.copyStatus.value = 'Copy failed' } }}>{ui.copyStatus.value || 'Copy command'}</button><span class="sr-only" aria-live="polite">{ui.copyStatus.value || ''}</span></div></details></div>
    <button class="button danger" onClick={() => perform(`/v1/sessions/${encodeURIComponent(session.id)}`, 'DELETE', 'Stop this session? Its workspace and conversation will be deleted.')}>Stop Session</button></div>
}

const eventTitle = (kind) => ({ created: 'Session created by controller', session_created: 'Session created by controller', ready: 'Sandbox ready', environment_ready: 'Sandbox ready', request_started: 'Request started', request_completed: 'Request completed', request_failed: 'Request failed', run_started: 'Work run started', opencode_idle: 'OpenCode turn finished', opencode_error: 'OpenCode turn failed', conversation_rebound: 'Conversation rebound', session_suspended: 'Session suspended', session_resumed: 'Session resumed', session_completed: 'Session completed', session_deleted: 'Session deleted' }[kind] || 'Session activity')
function Logs({ activity, ui }) {
  if (!activity) return <div class="content-section"><div class="loading">Loading activity...</div></div>
  if (!activity.requests?.length && !activity.lifecycle?.length) return <div class="content-section"><div class="empty"><strong>No activity recorded</strong>OpenCode has not recorded any requests for this session yet.</div></div>
  return <div class="content-section"><div class="section-heading"><h3>Lifecycle &amp; requests</h3><span>{activity.requests.length} request{activity.requests.length === 1 ? '' : 's'}</span></div><div class="timeline"><LifecycleTimeline events={activity.lifecycle}/>{activity.requests.map((request) => <RequestCard key={request.id || request.number} request={request} ui={ui}/>)}</div></div>
}
function LifecycleTimeline({ events }) {
  return events.map((event, index) => <div key={`${event.at}-${index}`} class={`timeline-event event-${event.kind}`}><div class="event-time">{formatClock(event.at)}</div><div class="event-body"><span class="event-marker"/><div class="event-title">{eventTitle(event.kind)}</div>{event.detail && <div class="event-detail">{event.detail}</div>}</div></div>)
}
function RequestCard({ request, ui }) {
  const id = request.id || `request-${request.number}`, isExpanded = request.prompt.length < 500 || ui.expandedPrompts.value.has(id)
  const toggle = () => { const next = new Set(ui.expandedPrompts.value); next.has(id) ? next.delete(id) : next.add(id); ui.expandedPrompts.value = next }
  return <article class={`request-card ${request.state}`}><div class="request-top"><span><strong>Request #{request.number}</strong> · {request.origin}</span><span class="request-duration">{request.state === 'running' ? 'Running · ' : request.state === 'completed' ? 'Completed · ' : request.state === 'failed' ? 'Failed · ' : ''}<Clock value={request.started_at} end={request.completed_at}/></span></div><div class="prompt-label">Submitted prompt</div><pre class={`prompt ${isExpanded ? 'expanded' : ''}`} data-prompt-id={id}>{request.prompt}</pre>{request.prompt.length >= 500 && <button class="prompt-toggle" onClick={toggle}>{isExpanded ? 'Collapse prompt' : 'Show full prompt'}</button>}<div class="request-info"><span>Started {formatDate(request.started_at)}</span>{request.completed_at ? <span>Ended {formatDate(request.completed_at)}</span> : <span><Clock value={request.last_activity_at} relative/></span>}{(request.provider || request.model) && <span>{[request.provider, request.model].filter(Boolean).join(' / ')}</span>}{request.current_operation && <span>Now: {request.current_operation}</span>}</div>{request.error && <div class="failure">{request.error}</div>}</article>
}
function Runtime({ activity, session }) {
  const items = [['Environment', activity?.environment_state || session.environment_state], ['Execution', activity?.execution_state || 'idle'], ['Work state', activity?.work_state || session.work_state], ['Created', formatDate(session.created_at)], ['Sandbox', session.sandbox], ['Repository', session.repository], ['Base ref', session.base_ref]]
  return <div class="content-section"><div class="section-heading"><h3>Runtime details</h3><span>Technical information</span></div>{(activity?.environment_error || session.environment_error) && <div class="failure">{activity?.environment_error || session.environment_error}</div>}<div class="runtime-grid">{items.map(([label, value]) => <div key={label} class="runtime-item"><label>{label}</label><span>{value}</span></div>)}</div></div>
}

if (typeof window !== 'undefined' && !window.__ANVIL_TEST__) render(<AppShell/>, document.getElementById('app'))
