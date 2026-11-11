'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { request } from './api'

const href = (path, id) => id ? `${path}?id=${encodeURIComponent(id)}` : path
const recordedFocus = item => item.task?.operator_hold === true || item.attempt?.state === 'failed' || item.commission?.start_authorized === false

export default function Inbox() {
  const [items, setItems] = useState([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [cursor, setCursor] = useState(null)
  const [view, setView] = useState('focused')
  const requestInFlight = useRef(false)
  const load = useCallback(async (after = null) => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    setLoading(true); setError('')
    try {
      const result = await request(`/inbox?limit=20${after ? `&after=${encodeURIComponent(after)}` : ''}`)
      if (result?.schema_version !== 1 || !Array.isArray(result.items)) throw new Error('Inbox response did not match schema version 1.')
      setItems(current => after ? [...current, ...result.items] : result.items)
      setCursor(result.next_cursor || null)
    } catch (e) { setError(e.message) }
    finally { requestInFlight.current = false; setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  const visible = useMemo(() => view === 'focused' ? items.filter(recordedFocus) : items, [items, view])

  return <section className="inbox-panel" aria-labelledby="inbox-title">
    <div className="section-heading inbox-heading"><div><span className="eyebrow">RECORDED WORK</span><h2 id="inbox-title">Inbox</h2></div><div className="inbox-controls" aria-label="Inbox view">
      <button type="button" className={view === 'focused' ? 'text-link selected' : 'text-link'} aria-pressed={view === 'focused'} onClick={() => setView('focused')}>Focused</button>
      <button type="button" className={view === 'everything' ? 'text-link selected' : 'text-link'} aria-pressed={view === 'everything'} onClick={() => setView('everything')}>Everything</button>
    </div></div>
    <p className="inbox-note">Focused shows recorded operator holds, latest attempts whose state is <code>failed</code>, or commissions recorded as not start-authorized. Authorization is a recorded commission state, not an assessment of scheduler readiness. Everything lists all returned Inbox records.</p>
    {loading && items.length === 0 && <p className="muted" role="status">Loading Inbox…</p>}
    {error && <div className="notice error" role="alert">Inbox: {error} <button className="text-link" type="button" onClick={() => load()}>Retry</button></div>}
    {visible.length > 0 ? <div className="contract-list">{visible.map(item => <article className="contract-row inbox-row" key={`${item.commission_id}:${item.local_key}`}>
      <span className="status-dot" aria-hidden="true"/><div className="contract-main"><b>{item.objective || item.local_key}</b><small>{item.local_key} · Task {item.task?.state || 'not reported'} · Commission {item.commission?.state || 'not reported'}</small>
        <small>Commission v{item.commission?.version ?? '—'} · {item.commission?.start_authorized ? 'Start authorized' : 'Start not authorized'} · Controller {item.task?.controller_mode || 'not reported'}</small>
        <small>{item.task?.operator_hold ? `Operator hold${item.task.hold_reason ? `: ${item.task.hold_reason}` : ''}` : 'No operator hold recorded'} · Retry {item.task?.retry_due_ms == null ? 'not scheduled' : `due ${item.task.retry_due_ms}`}</small>
        {item.attempt ? <small>Latest attempt #{item.attempt.ordinal} · {item.attempt.attempt_id} · {item.attempt.state}{item.attempt.failure_reason ? ` · ${item.attempt.failure_reason}` : ''}</small> : <small>No attempt recorded</small>}
        <small>Start after: {item.start_after?.join(', ') || 'none'} · Integration after: {item.integration_after?.join(', ') || 'none'}</small>
      </div><div className="inbox-links"><a href={href('/campaign', item.campaign_id)}>Campaign</a><a href={href('/commission', item.commission_id)}>Commission</a>{item.attempt?.session_id && <a href={href('/sessions', item.attempt.session_id)}>Session</a>}</div>
    </article>)}</div> : !loading && !error && <div className="empty"><h3>{view === 'focused' ? cursor ? 'No Focused items on this page' : 'No recorded focus items' : 'No Inbox items returned'}</h3><p>{view === 'focused' ? cursor ? 'No matching records are in the pages loaded so far; additional pages have not been checked.' : 'No operator holds, latest failed attempts, or commissions recorded as not start-authorized are present in the records currently loaded.' : 'The Inbox endpoint returned no records.'}</p></div>}
    {cursor && <div className="inbox-more"><button type="button" className="button quiet" disabled={loading} onClick={() => load(cursor)}>{loading ? 'Loading…' : 'Load 20 more'}</button><span className="hint">More records are available; pages load only when requested.</span></div>}
    {!cursor && items.length > 0 && <p className="hint inbox-count">{visible.length} shown from {items.length} loaded record{items.length === 1 ? '' : 's'} · No additional page reported.</p>}
  </section>
}
