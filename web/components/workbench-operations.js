'use client'

import { useEffect, useState } from 'react'
import { request } from './api'

const tabs = [['fleet', 'Fleet'], ['performance', 'Performance'], ['budget', 'Budget']]
const value = (object, key) => object?.[key] == null ? 'Unavailable' : String(object[key])

export default function OperationsPanel() {
  const [tab, setTab] = useState('fleet')
  const [capacity, setCapacity] = useState(null)
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState([])

  useEffect(() => {
    let current = true
    Promise.allSettled([request('/capacity'), request('/sessions')]).then(([capacityResult, sessionsResult]) => {
      if (!current) return
      const nextErrors = []
      if (capacityResult.status === 'fulfilled') setCapacity(capacityResult.value)
      else nextErrors.push(`Capacity: ${capacityResult.reason.message}`)
      if (sessionsResult.status === 'fulfilled') {
        const result = sessionsResult.value
        setSessions(Array.isArray(result) ? result : Array.isArray(result?.sessions) ? result.sessions : [])
      } else nextErrors.push(`Sessions: ${sessionsResult.reason.message}`)
      setErrors(nextErrors)
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [])

  const count = sessions.length
  const fleet = <>
    <div className="metric-grid">
      <div className="metric"><strong>{loading && !capacity ? 'Loading…' : value(capacity, 'running')}</strong><span>Running · returned by capacity API</span></div>
      <div className="metric"><strong>{loading && !capacity ? 'Loading…' : value(capacity, 'provisioning')}</strong><span>Provisioning · returned by capacity API</span></div>
      <div className="metric"><strong>{loading ? 'Loading…' : String(count)}</strong><span>Sessions returned by Sessions API</span></div>
    </div>
    <div className="two-panels">
      <section className="panel"><h2>Scheduler capacity</h2>
        <div className="data-row"><span>Global limit · returned</span><b>{value(capacity, 'global_limit')}</b></div>
        <div className="data-row"><span>Available slots · returned</span><b>{value(capacity, 'available_slots')}</b></div>
        <div className="data-row"><span>Queued runnable · returned</span><b>{value(capacity, 'queued_runnable')}</b></div>
        <div className="data-row"><span>Controller health</span><b>Unavailable</b></div>
        <div className="data-row"><span>Pod health</span><b>Unavailable</b></div>
      </section>
      <section className="panel"><h2>Sessions returned</h2>
        {loading && <p className="muted" role="status">Loading sessions…</p>}
        {!loading && sessions.length === 0 && <p className="muted">No sessions returned.</p>}
        {sessions.map((session, index) => <div className="data-row" key={session.id || index}><span>{session.project || session.id || 'Session'}</span><span>{session.environment_state || 'Environment state unavailable'} · {session.execution_state || 'Execution state unavailable'}</span></div>)}
      </section>
    </div>
  </>

  const performance = <>
    <div className="metric-grid"><div className="metric"><strong>Unavailable</strong><span>30-day integrated Commissions</span></div><div className="metric"><strong>Unavailable</strong><span>Median time to integration</span></div><div className="metric"><strong>Unavailable</strong><span>p90 time to integration</span></div></div>
    <section className="panel"><h2>Convergence and review</h2>
      {['Median review-ready to decision', 'Attempts per integrated Commission', 'Failure / recovery outcomes', 'Model turns vs integrated outcomes'].map(label => <div className="data-row" key={label}><span>{label}</span><b>Unavailable</b></div>)}
      <p className="muted">No 30-day performance metrics are available from the permitted API endpoints.</p>
    </section>
  </>

  const budget = <>
    <div className="metric-grid"><div className="metric"><strong>Unavailable</strong><span>Measured spend</span></div><div className="metric"><strong>Unavailable</strong><span>Estimated spend</span></div><div className="metric"><strong>Unavailable</strong><span>Provider quota</span></div></div>
    <section className="panel"><h2>Provider and model budget</h2><div className="table-scroll"><table><thead><tr><th>Provider / model</th><th>Usage</th><th>Quota</th><th>Utilization</th><th>Capacity</th></tr></thead><tbody><tr><td>All providers</td><td>Unavailable</td><td>Unavailable</td><td>Unavailable</td><td>Unavailable</td></tr></tbody></table></div>
      <p className="callout">Spend and quota are unavailable from the returned capacity and session records. Unobserved values are not inferred.</p>
    </section>
  </>

  return <section className="workbench-operations">
    <div className="view-head"><div><p className="eyebrow">RUNTIME AND DELIVERY</p><h1>Operations</h1><p className="sub">Measured scheduler capacity and returned session records; other health and outcome data are unavailable.</p></div></div>
    <div className="ops-tabs" role="tablist" aria-label="Operations views">{tabs.map(([key, title]) => <button type="button" className="btn" role="tab" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{title}</button>)}</div>
    {errors.map(error => <div className="notice error" role="alert" key={error}>{error}</div>)}
    {tab === 'fleet' ? fleet : tab === 'performance' ? performance : budget}
  </section>
}
