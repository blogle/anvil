import { h } from 'preact'
import { chronologicalTimeline, formatClock, formatDate } from './state.js'
import { Clock } from './clock.jsx'

const React = { createElement: h }

const eventTitle = (kind) => ({ created: 'Session created by controller', session_created: 'Session created by controller', ready: 'Sandbox ready', environment_ready: 'Sandbox ready', request_started: 'Request started', request_completed: 'Request completed', request_failed: 'Request failed', run_started: 'Run started', opencode_idle: 'OpenCode reported idle', opencode_error: 'OpenCode reported an error', conversation_rebound: 'Conversation rebound', session_suspended: 'Session suspended', session_resumed: 'Session resumed', session_deleted: 'Session deleted' }[kind] || 'Session activity')

export function Logs({ activity, ui }) {
  if (!activity) return <div class="content-section"><div class="loading">Loading activity...</div></div>
  if (!activity.requests?.length && !activity.lifecycle?.length) return <div class="content-section"><div class="empty"><strong>No Trail entries</strong>Controller lifecycle events and request diagnostics will appear here.</div></div>
  return <div class="content-section"><div class="section-heading"><h3>Trail · Lifecycle &amp; requests</h3><span>{activity.requests.length} request{activity.requests.length === 1 ? '' : 's'}</span></div><div class="timeline">{chronologicalTimeline(activity).map(({ type, value }) => type === 'request' ? <RequestTimelineItem key={value.id || value.number} request={value} ui={ui}/> : <LifecycleItem key={value.id || `${value.kind}:${value.at}:${value.detail || ''}`} event={value}/>)}</div></div>
}

function LifecycleItem({ event }) {
  return <div class={`timeline-event timeline-lifecycle event-${event.kind}`} data-timeline-item="event" data-event-kind={event.kind} data-event-id={event.id || ''}><div class="event-time">{formatClock(event.at)}</div><div class="event-body"><span class="event-marker"/><div class="event-title">{eventTitle(event.kind)}</div>{event.detail && <div class="event-detail">{event.detail}</div>}</div></div>
}

function RequestTimelineItem({ request, ui }) {
  const id = request.id || `request-${request.number}`, isExpanded = request.prompt.length < 500 || ui.expandedPrompts.value.has(id)
  const toggle = () => { const next = new Set(ui.expandedPrompts.value); next.has(id) ? next.delete(id) : next.add(id); ui.expandedPrompts.value = next }
  return <div class={`timeline-event timeline-request request-${request.state}`} data-timeline-item="request" data-request-number={request.number}><div class="event-time">{formatClock(request.started_at)}</div><div class="event-body"><span class={`event-marker request-marker request-marker-${request.state}`}/><article class={`request-card ${request.state}`}><div class="request-top"><span><strong>Request #{request.number}</strong> · {request.origin}</span><span class="request-duration">{request.state === 'running' ? 'Running · ' : request.state === 'completed' ? 'Completed · ' : request.state === 'failed' ? 'Failed · ' : ''}<Clock value={request.started_at} end={request.completed_at}/></span></div><div class="prompt-label">Submitted prompt</div><pre class={`prompt ${isExpanded ? 'expanded' : ''}`} data-prompt-id={id}>{request.prompt}</pre>{request.prompt.length >= 500 && <button class="prompt-toggle" onClick={toggle}>{isExpanded ? 'Collapse prompt' : 'Show full prompt'}</button>}<div class="request-info"><span>Started {formatDate(request.started_at)}</span>{request.completed_at ? <span>Ended {formatDate(request.completed_at)}</span> : <span><Clock value={request.last_activity_at} relative/></span>}{(request.provider || request.model) && <span>{[request.provider, request.model].filter(Boolean).join(' / ')}</span>}{request.current_operation && <span>Now: {request.current_operation}</span>}</div>{request.error && <div class="failure">{request.error}</div>}</article></div></div>
}
