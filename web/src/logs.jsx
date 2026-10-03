import { h } from 'preact'
import { formatClock, formatDate } from './state.js'
import { Clock } from './clock.jsx'

const React = { createElement: h }

const eventTitle = (kind) => ({ created: 'Session created by controller', session_created: 'Session created by controller', ready: 'Sandbox ready', environment_ready: 'Sandbox ready', request_started: 'Request started', request_completed: 'Request completed', request_failed: 'Request failed', run_started: 'Run started', opencode_idle: 'OpenCode reported idle', opencode_error: 'OpenCode reported an error', conversation_rebound: 'Conversation rebound', session_suspended: 'Session suspended', session_resumed: 'Session resumed', session_deleted: 'Session deleted' }[kind] || 'Session activity')

export function Logs({ activity, ui }) {
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
