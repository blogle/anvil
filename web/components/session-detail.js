'use client'

import { useEffect, useState } from 'react'
import { request } from './api'
import { openCodeConversationUrl } from './opencode-link'

export default function SessionDetail({ session }) {
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setResult(null)
    setError('')
    request(`/sessions/${encodeURIComponent(session.id)}/activity`)
      .then(value => { if (active) setResult(value) })
      .catch(value => { if (active) setError(value.message) })
    return () => { active = false }
  }, [session.id])

  const activity = result
  const link = openCodeConversationUrl(activity?.opencode_url, activity?.session?.opencode_session_id || session.opencode_session_id)
  const preview = safeHttpUrl(activity?.preview_url)
  return <section className="record-card session-detail" data-session-detail>
    <a href="/sessions" className="text-link">← All sessions</a>
    <span className="card-index">SESSION DETAIL</span>
    <h2>{session.project || session.id}</h2><code>{session.id}</code>
    <div className="record-meta">Environment: {activity?.environment_state || session.environment_state || 'Unknown'} <span>·</span> Execution: {activity?.execution_state || session.execution_state || 'Unknown'}</div>
    <p className="hint">Branch: {session.work_branch || 'Not reported'} · Created: {session.created_at || 'Not reported'}</p>
    {error && <div className="notice error" role="alert">Could not load session activity: {error}</div>}
    {!activity && !error && <p className="muted">Loading session activity…</p>}
    {activity && <>
      <div className="hero-actions session-actions">
        {preview && <a className="button primary" href={preview} target="_blank" rel="noreferrer">Open Preview</a>}
        {link ? <a className="button" data-opencode-link href={link} target="_blank" rel="noreferrer">Open in OpenCode</a> : <span className="muted">OpenCode conversation unavailable</span>}
      </div>
      {activity.attach_command && <details className="attach"><summary className="button">Attach command</summary><code className="command">{activity.attach_command}</code></details>}
      <section className="session-activity"><h3>Conversation &amp; execution</h3>
        {activity.events?.length ? activity.events.map((event, index) => <article key={event.id || index} className="transcript-row" data-event-id={event.id}><span>{event.kind || 'Activity'}</span><div><b>{event.title || event.tool || ''}</b>{event.detail && <p>{event.detail}</p>}</div></article>) : <p className="muted">No conversation activity yet.</p>}
      </section>
    </>}
  </section>
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch { return null }
}
