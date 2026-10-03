import { h } from 'preact'
import { activityHistoryNotice, activityKindLabel, formatClock, loadOlderActivity, orderedActivityEvents, sessionUI } from './state.js'

const React = { createElement: h }

export function Activity({ activity, sessionId }) {
  const ui = sessionUI(sessionId)
  if (!activity) return <div class="content-section"><div class="loading">Loading Activity…</div></div>
  const events = orderedActivityEvents(activity)
  const notice = activityHistoryNotice(activity)
  return <div class="content-section">
    <div class="section-heading"><h3>Conversation &amp; execution</h3><span>{events.length}{events.length === 500 ? '+' : ''} entries</span></div>
    {notice && <div class="activity-truncation" role="status">{notice}</div>}
    {!events.length ? <div class="empty"><strong>No conversation activity yet</strong>Prompts, agent responses, and tool activity will appear here.</div> :
      <div class="activity-transcript" aria-label="Agent conversation and execution transcript">
        {events.map((event) => <TranscriptEvent key={event.id} event={event}/>)}
      </div>}
    {ui.olderError.value && <div class="failure" role="alert">Could not load older Activity: {ui.olderError.value}</div>}
    {activity.event_window?.next_cursor && <button class="button load-older" disabled={ui.loadingOlder.value} onClick={() => loadOlderActivity(sessionId).catch(() => {})}>
      {ui.loadingOlder.value ? 'Loading older Activity…' : 'Load older Activity'}
    </button>}
  </div>
}

function TranscriptEvent({ event }) {
  const kind = event.kind || 'activity'
  const prose = kind === 'prompt' || kind === 'message'
  const hasHeading = kind === 'tool' || kind === 'error'
  return <article class={`transcript-row transcript-${kind}`} data-event-id={event.id}>
    <time class="event-time" dateTime={event.at}>{formatClock(event.at)}</time>
    <span class={`transcript-kind kind-${kind}`}>{activityKindLabel(event)}</span>
    <div class="transcript-copy">
      {hasHeading && <div class="transcript-title">{event.title || event.tool || kind}{event.status && <span class={`activity-status status-${event.status}`}>{event.status === 'completed' ? 'done' : event.status}</span>}</div>}
      {event.detail && (prose ? <div class="transcript-prose">{event.detail}</div> : <pre class="transcript-detail">{event.detail}</pre>)}
    </div>
  </article>
}
