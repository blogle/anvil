'use client'

import { useEffect, useState } from 'react'
import { request } from './api'

const PAGE_SIZE = 20

export default function DecisionHistory({ taskId }) {
  const [decisions, setDecisions] = useState([])
  const [cursor, setCursor] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    setDecisions([]); setCursor(null); setHasMore(false); setError('')
    if (!taskId) return () => { current = false }
    setLoading(true)
    request(`/tasks/${encodeURIComponent(taskId)}/decisions?limit=${PAGE_SIZE}`)
      .then(page => {
        if (!current) return
        const records = Array.isArray(page?.decisions) ? page.decisions : []
        setDecisions(records)
        setCursor(page?.next_cursor)
        setHasMore(page?.next_cursor != null)
      })
      .catch(e => { if (current) setError(e.message) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [taskId])

  async function loadMore() {
    if (!taskId || !hasMore || loading) return
    setLoading(true); setError('')
    try {
      const page = await request(`/tasks/${encodeURIComponent(taskId)}/decisions?cursor=${encodeURIComponent(cursor)}&limit=${PAGE_SIZE}`)
      const records = Array.isArray(page?.decisions) ? page.decisions : []
      setDecisions(previous => [...previous, ...records])
      setCursor(page?.next_cursor)
      setHasMore(page?.next_cursor != null)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  const complete = !loading && !error && !hasMore
  return <section className="data-card decision-history" aria-label="Recorded control decisions">
    <h3>Recorded control decisions</h3>
    <p>Durable decision history for this Task (the Commission ID is used as the Task ID). This is recorded history, not a live watchdog view.</p>
    {loading && decisions.length === 0 && <p className="muted">Loading decision history…</p>}
    {error && <div className="notice error" role="alert">Decision history unavailable: {error}</div>}
    {!loading && !error && decisions.length === 0 && <p className="muted">No decision history is recorded. No history is not evidence that the Task is healthy.</p>}
    {decisions.map((decision, index) => <article className="decision-record" key={`${decision.decision_sequence ?? index}:${decision.logical_time_ms}`}>
      <h4>Decision {decision.decision_sequence ?? index + 1}</h4>
      <dl><dt>Rule</dt><dd>{decision.rule_id || '—'}{decision.rule_id === 'no_progress' && <small> Historical rule result; this is not a live watchdog or current health assessment.</small>}</dd>
        <dt>Logical time (ms)</dt><dd>{decision.logical_time_ms ?? '—'}</dd>
        <dt>Authorization blocked reason</dt><dd>{decision.authorization_blocked_reason || 'None recorded'}</dd></dl>
      <p>Proposed actions: {Array.isArray(decision.canonical_actions_json) ? decision.canonical_actions_json.length : 'Unavailable'}</p>
    </article>)}
    {hasMore && <div><p className="muted">Showing only the fetched page(s). Later decisions may exist; no latest decision is asserted until every page has been fetched.</p><button type="button" className="button quiet" onClick={loadMore} disabled={loading}>{loading ? 'Loading…' : 'Load next decision page'}</button></div>}
    {complete && decisions.length > 0 && <p className="muted">All available decision pages have been fetched. This history still does not represent a live watchdog.</p>}
  </section>
}
