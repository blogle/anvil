'use client'

import { useEffect, useMemo, useState } from 'react'
import { getIdempotencyRecord, isDefinitiveRejection, request, resetIdempotencyRecord } from './api'
import DecisionHistory from './decision-history'

const TABS = [
  ['overview', 'Overview'],
  ['obligations', 'Obligations'],
  ['diff', 'Diff'],
  ['activity', 'Activity'],
  ['attempts', 'Attempts'],
]

const records = value => Array.isArray(value) ? value : []
const text = value => value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

function safeSessionId(value) {
  return typeof value === 'string' && sessionIdPattern.test(value) ? value : null
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch { return null }
}

function getAttempts(value) {
  if (Array.isArray(value)) return value
  return records(value?.attempts)
}

function getEvents(value) {
  if (Array.isArray(value)) return value
  return records(value?.events)
}

function getDiffEntries(value) {
  if (Array.isArray(value)) return value
  for (const key of ['diff', 'files', 'entries', 'changes']) {
    if (Array.isArray(value?.[key])) return value[key]
    if (typeof value?.[key] === 'string' && value[key]) return [{ path: key, patch: value[key] }]
  }
  if (typeof value === 'string' && value) return [{ patch: value }]
  return []
}

function sessionFor(attempt) {
  return safeSessionId(attempt?.session_id ?? attempt?.session?.id)
}

function ContextCell({ label, value }) {
  return <div className="context-cell"><span className="label">{label}</span><strong>{text(value)}</strong></div>
}

function Panel({ title, children, className = '' }) {
  return <section className={`panel ${className}`.trim()}><h3>{title}</h3>{children}</section>
}

function JsonValue({ value }) {
  return <pre className="diff">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>
}

export default function CommissionInspector({ item, onClose, expanded, onToggleExpand }) {
  const [detail, setDetail] = useState(null)
  const [attempts, setAttempts] = useState([])
  const [attemptCursor, setAttemptCursor] = useState(null)
  const [attemptsMore, setAttemptsMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [attemptsLoading, setAttemptsLoading] = useState(false)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [startKey, setStartKey] = useState('')
  const [startRejectedKey, setStartRejectedKey] = useState('')
  const [model, setModel] = useState('')
  const [preparingAttempt, setPreparingAttempt] = useState(false)
  const [attemptRejectedKey, setAttemptRejectedKey] = useState('')
  const [attemptError, setAttemptError] = useState('')
  const [startWithoutModel, setStartWithoutModel] = useState(false)
  const [attemptsError, setAttemptsError] = useState('')
  const [tab, setTab] = useState('overview')
  const [selectedAttemptKey, setSelectedAttemptKey] = useState(null)
  const [sessionData, setSessionData] = useState({})

  const commissionId = item?.commission_id

  useEffect(() => {
    let active = true
    setDetail(null)
    setAttempts([])
    setAttemptCursor(null)
    setAttemptsMore(false)
    setError('')
    setAttemptsError('')
    setSessionData({})
    setSelectedAttemptKey(null)
    setModel('')
    setPreparingAttempt(false)
    setAttemptRejectedKey('')
    setAttemptError('')
    setStartWithoutModel(false)
    setTab('overview')
    if (!commissionId) return () => { active = false }
    setLoading(true)
    setAttemptsLoading(true)
    request(`/commissions/${encodeURIComponent(commissionId)}`)
      .then(commission => { if (active) setDetail(commission) })
      .catch(e => { if (active) setError(e.message) })
      .finally(() => { if (active) setLoading(false) })
    request(`/tasks/${encodeURIComponent(commissionId)}/attempts?limit=50`)
      .then(page => {
        if (!active) return
        setAttempts(getAttempts(page))
        const cursor = page?.next_cursor ?? page?.next_page_cursor ?? null
        setAttemptCursor(cursor)
        setAttemptsMore(cursor != null)
      })
      .catch(e => { if (active) setAttemptsError(e.message) })
      .finally(() => { if (active) setAttemptsLoading(false) })
    return () => { active = false }
  }, [commissionId])

  const sortedAttempts = useMemo(() => [...attempts].sort((a, b) => {
    const aNumber = Number(a?.ordinal ?? a?.attempt ?? a?.attempt_number ?? 0)
    const bNumber = Number(b?.ordinal ?? b?.attempt ?? b?.attempt_number ?? 0)
    return bNumber - aNumber
  }), [attempts])
  const latestAttempt = sortedAttempts[0] || detail?.latest_attempt || null
  const latestAttemptState = latestAttempt?.lifecycle?.state ?? latestAttempt?.lifecycle ?? latestAttempt?.state ?? latestAttempt?.status
  const latestAttemptFailure = latestAttempt?.failure?.summary ?? latestAttempt?.failure ?? latestAttempt?.failure_reason ?? latestAttempt?.error
  const latestAttemptFailed = String(latestAttemptState ?? '').toLowerCase() === 'failed' || Boolean(latestAttemptFailure)
  const operatorHold = item?.task?.operator_hold === true
  const selectedAttempt = sortedAttempts.find((attempt, index) => attemptKey(attempt, index) === selectedAttemptKey) || latestAttempt
  const selectedSessionId = sessionFor(selectedAttempt)
  const campaignId = detail?.campaign_id ?? item?.campaign_id
  const title = detail?.objective ?? item?.objective ?? item?.title ?? `Commission ${text(commissionId)}`
  const startAuthorized = detail?.task?.start_authorized ?? detail?.start_authorized
  const hasAnyAttempt = sortedAttempts.length > 0 || Boolean(detail?.latest_attempt)
  const attemptWithModel = sortedAttempts.find(attempt => typeof attempt?.model === 'string' && attempt.model.trim())
    || (typeof detail?.latest_attempt?.model === 'string' && detail.latest_attempt.model.trim() ? detail.latest_attempt : null)

  useEffect(() => {
    if (!selectedSessionId || !['activity', 'diff'].includes(tab)) return undefined
    const kind = tab
    const key = `${selectedSessionId}:${kind}`
    if (sessionData[key]?.loaded || sessionData[key]?.loading) return undefined
    let active = true
    setSessionData(current => ({ ...current, [key]: { loading: true, loaded: false, error: '' } }))
    request(`/sessions/${encodeURIComponent(selectedSessionId)}/${kind}`)
      .then(value => { if (active) setSessionData(current => ({ ...current, [key]: { value, loaded: true, loading: false, error: '' } })) })
      .catch(e => { if (active) setSessionData(current => ({ ...current, [key]: { loaded: true, loading: false, error: e.message } })) })
    return () => { active = false }
    // sessionData is intentionally omitted: updating the request state must not
    // restart the same request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, tab])

  async function loadNextAttempts() {
    if (!attemptCursor || attemptsLoading) return
    setAttemptsLoading(true)
    setAttemptsError('')
    try {
      const page = await request(`/tasks/${encodeURIComponent(commissionId)}/attempts?after=${encodeURIComponent(attemptCursor)}&limit=50`)
      setAttempts(previous => [...previous, ...getAttempts(page)])
      const cursor = page?.next_cursor ?? page?.next_page_cursor ?? null
      setAttemptCursor(cursor)
      setAttemptsMore(cursor != null)
    } catch (e) { setAttemptsError(e.message) }
    finally { setAttemptsLoading(false) }
  }

  async function startCommission(event) {
    event.preventDefault()
    setError('')
    const storageKey = `anvil-commission-key-${commissionId}`
    const body = JSON.stringify({ expected_version: detail.version })
    const { record, conflict } = getIdempotencyRecord(localStorage, storageKey, body)
    if (conflict) {
      setError('The uncertain start request is retained for its original version. Refresh and reset it explicitly before starting this version.')
      return
    }
    const savedKey = record.key
    setStartKey(savedKey)
    setStarting(true)
    try {
      await request(`/commissions/${encodeURIComponent(commissionId)}/start`, { method: 'POST', headers: { 'Idempotency-Key': savedKey }, body })
    } catch (e) {
      const rejected = isDefinitiveRejection(e)
      setStartRejectedKey(rejected ? storageKey : '')
      setError(rejected
        ? `${e.message} The server rejected this start request; you may reset its key before starting a revised version.`
        : `${e.message} The outcome is uncertain. Keep the original key and version, retry them, or inspect the Commission receipt before taking another action.`)
      setStarting(false)
      return
    } finally { setStarting(false) }
    resetIdempotencyRecord(localStorage, storageKey)
    setStartKey('')
    setStartRejectedKey('')
    try { setDetail(await request(`/commissions/${encodeURIComponent(commissionId)}`)) }
    catch (e) { setError(`Commission start was accepted, but refreshing its contract failed: ${e.message}`) }
  }

  async function prepareAttempt(event) {
    event.preventDefault()
    setAttemptError('')
    const selectedModel = model.trim()
    if (!/^[^/\s]+\/[^\s]+$/.test(selectedModel) || selectedModel.length > 256) {
      setAttemptError('Enter a qualified provider/model value (maximum 256 characters).')
      return
    }
    const storageKey = `anvil-attempt-key-${commissionId}`
    const body = JSON.stringify({ model: selectedModel })
    const { record, conflict } = getIdempotencyRecord(localStorage, storageKey, body)
    if (conflict) {
      setAttemptError('The uncertain preparation request is retained for its original model. Retry that model or inspect the Attempt receipt.')
      return
    }
    setPreparingAttempt(true)
    setAttemptRejectedKey('')
    try {
      await request(`/tasks/${encodeURIComponent(commissionId)}/attempts`, { method: 'POST', headers: { 'Idempotency-Key': record.key }, body })
    } catch (e) {
      const rejected = isDefinitiveRejection(e)
      setAttemptRejectedKey(rejected ? storageKey : '')
      setAttemptError(rejected
        ? `${e.message} The server rejected this preparation; reset its key before trying again.`
        : `${e.message} The outcome is uncertain. Keep the original model and key, retry, or inspect the Attempt receipt.`)
      setPreparingAttempt(false)
      return
    }
    resetIdempotencyRecord(localStorage, storageKey)
    setAttemptRejectedKey('')
    setModel('')
    try {
      const page = await request(`/tasks/${encodeURIComponent(commissionId)}/attempts`)
      setAttempts(getAttempts(page))
      setAttemptCursor(page?.next_cursor ?? page?.next_page_cursor ?? null)
      setAttemptsMore((page?.next_cursor ?? page?.next_page_cursor ?? null) != null)
      setTab('attempts')
    } catch (e) { setAttemptError(`Attempt preparation was accepted, but refreshing attempts failed: ${e.message}`) }
    finally { setPreparingAttempt(false) }
  }

  const identityStatus = detail?.state ?? item?.state ?? item?.status
  const attemptOrdinal = item?.attempt?.ordinal ?? item?.attempt?.attempt_number ?? latestAttempt?.ordinal ?? latestAttempt?.attempt_number
  const itemAttempt = typeof attemptOrdinal === 'string' || typeof attemptOrdinal === 'number' ? attemptOrdinal : null
  const identitySessionId = sessionFor(item?.attempt && typeof item.attempt === 'object' ? item.attempt : latestAttempt)
  const selectedKind = tab

  return <aside className="inspector" aria-label="Commission inspector">
    <div className="inspector-head">
      <button type="button" className="btn inspector-back" onClick={onClose}>← Back</button>
      <div className="inspector-tools">
        <span className="eyebrow">COMMISSION INSPECTOR</span>
        <button type="button" className="btn" onClick={onToggleExpand}>{expanded ? 'Collapse workbench' : 'Expand workbench'}</button>
      </div>
      <h2 className="inspector-title">{text(title)}</h2>
      <div className="persistent-identity">
        <span>Commission ID · <strong>{text(commissionId)}</strong></span>
        <span>State · <strong>{text(identityStatus)}</strong></span>
        <span>Attempt ordinal · <strong>{text(itemAttempt)}</strong></span>
        <span>Session ID · <strong>{identitySessionId || '—'}</strong></span>
      </div>
    </div>

    <div className="tabs" role="tablist" aria-label="Commission details">
      {TABS.map(([key, label]) => <button type="button" role="tab" id={`commission-tab-${key}`} aria-controls="commission-tab-panel" aria-selected={tab === key} className="tab" key={key} onClick={() => setTab(key)}>{label}</button>)}
    </div>

    <div className="inspector-body" id="commission-tab-panel" role="tabpanel" aria-labelledby={`commission-tab-${selectedKind}`}>
      {loading && !detail && <p className="muted" role="status">Loading Commission…</p>}
      {error && <p className="notice" role="alert">Could not load Commission: {error}</p>}
      {tab === 'overview' && <>
        <Panel title="Recorded next action" className="decision-panel">
          {startAuthorized === false ? <>
              <p>Start not authorized in current Commission record; authorization is not scheduler readiness</p>
              {attemptWithModel && <p className="muted">Prepared model recorded: <strong>{text(attemptWithModel.model)}</strong>. Start remains a separate explicit action.</p>}
              {typeof detail.version === 'number' && Number.isFinite(detail.version) && <form className="mock-actions" onSubmit={startCommission}>
                <p className="muted">Start this Commission using the currently recorded contract version.</p>
                {!attemptWithModel && <>
                  <p className="notice">No prepared model is recorded. OpenCode's default may differ; explicitly opt in to starting without a prepared model.</p>
                  <label className="checkline"><input type="checkbox" checked={startWithoutModel} onChange={event => setStartWithoutModel(event.target.checked)}/> Start without a prepared model</label>
                </>}
                {error && <p className="notice" role="alert">{error}</p>}
                <div className="toolbar">
                <button type="submit" className="btn primary" disabled={starting || (!attemptWithModel && !startWithoutModel)}>{starting ? 'Starting…' : 'Start Commission'}</button>
                {startRejectedKey && <button type="button" className="btn" disabled={starting} onClick={() => { resetIdempotencyRecord(localStorage, startRejectedKey); setStartKey(''); setStartRejectedKey(''); setError('Rejected start request reset. Starting again will use a new key.') }}>Reset rejected request</button>}
                {startKey && <span className="dim">Idempotency key retained for retry</span>}
              </div>
            </form>}
          </> : null}
          {latestAttemptFailed && <p className="notice">{latestAttemptFailure ? `Recorded failure: ${text(latestAttemptFailure)}` : 'Latest attempt is recorded as failed.'}</p>}
          {operatorHold && <p className="notice">{item.task.hold_reason ? `Recorded operator hold: ${text(item.task.hold_reason)}` : 'An operator hold is recorded.'}</p>}
          {startAuthorized !== false && !latestAttemptFailed && !operatorHold && <p className="muted">No current operator action is established by this view.</p>}
        </Panel>
        <Panel title="Commission contract">
          {detail ? <>
            <p>{text(detail.objective)}</p>
            <div className="context-grid">
              <ContextCell label="Version" value={detail.version}/>
              <ContextCell label="Start authorized" value={typeof startAuthorized === 'boolean' ? startAuthorized ? 'Yes' : 'No' : 'Not reported'}/>
              <ContextCell label="Start after" value={detail.start_after?.length ? detail.start_after.join(', ') : 'None'}/>
              <ContextCell label="Integration after" value={detail.integration_after?.length ? detail.integration_after.join(', ') : 'None'}/>
              <ContextCell label="Repository" value={detail.execution_target?.repository}/>
              <ContextCell label="Base ref" value={detail.execution_target?.base_ref}/>
              <ContextCell label="Delivery" value={detail.execution_target?.delivery}/>
              <ContextCell label="Kind" value={detail.execution_target?.kind}/>
            </div>
            <div className="link-list">
              {campaignId && <a className="example-link" href={`/campaign?id=${encodeURIComponent(campaignId)}`}>Campaign · {text(campaignId)}</a>}
              {safeHttpUrl(detail.execution_target?.repository) && <a className="example-link" href={safeHttpUrl(detail.execution_target.repository)} target="_blank" rel="noopener noreferrer">Repository</a>}
            </div>
          </> : !loading && !error && <p className="muted">No Commission contract returned.</p>}
        </Panel>
        {detail && <Panel title="Recorded latest attempt">
          {latestAttempt ? <>
            <div className="context-grid">
              <ContextCell label="Attempt" value={latestAttempt.ordinal ?? latestAttempt.attempt ?? latestAttempt.attempt_number}/>
              <ContextCell label="State" value={latestAttempt.lifecycle?.state ?? latestAttempt.lifecycle ?? latestAttempt.state ?? latestAttempt.status}/>
              <ContextCell label="Started" value={latestAttempt.started_at}/>
              <ContextCell label="Finished" value={latestAttempt.ended_at ?? latestAttempt.finished_at}/>
            </div>
            {(latestAttempt.failure || latestAttempt.failure_reason || latestAttempt.error) && <p className="notice">Recorded failure: {text(latestAttempt.failure?.summary ?? latestAttempt.failure ?? latestAttempt.failure_reason ?? latestAttempt.error)}</p>}
            {sessionFor(latestAttempt) && <a className="example-link" href={`/sessions?id=${encodeURIComponent(sessionFor(latestAttempt))}`}>Open bound session · {sessionFor(latestAttempt)}</a>}
          </> : <p className="muted">No attempt is recorded.</p>}
        </Panel>}
        {detail && <DecisionHistory taskId={commissionId} />}
      </>}

      {tab === 'obligations' && <Panel title="Contract obligations and acceptance expectations">
        {detail && Array.isArray(detail.obligations) && detail.obligations.length ? detail.obligations.map((obligation, index) => <article className="mini-row" key={obligation.id ?? index}>
          <strong>{text(obligation.id)}{obligation.version != null ? ` · v${obligation.version}` : ''}</strong>
          <p>{text(obligation.requirement)}</p>
          {Array.isArray(obligation.acceptance_expectations) && obligation.acceptance_expectations.length > 0 && <ul>{obligation.acceptance_expectations.map((expectation, i) => <li key={i}>{text(expectation)}</li>)}</ul>}
        </article>) : <p className="muted">No obligation requirements are recorded in the contract.</p>}
      </Panel>}

      {tab === 'attempts' && <Panel title="Recorded attempts">
        {detail?.task?.start_authorized === false && !attemptsLoading && !hasAnyAttempt && <form className="mock-form attempt-prepare" onSubmit={prepareAttempt}>
          <h3>Prepare Attempt</h3>
          <label htmlFor="attempt-model">Qualified model</label>
          <input id="attempt-model" name="model" type="text" maxLength={256} required value={model} placeholder="openai/gpt-5.6-luna" onChange={event => setModel(event.target.value)} />
          <p className="muted">Use provider/model (maximum 256 characters); preparing does not start a worker.</p>
          {attemptError && <p className="notice" role="alert">{attemptError}</p>}
          <div className="toolbar">
            <button type="submit" className="btn primary" disabled={preparingAttempt}>{preparingAttempt ? 'Preparing…' : 'Prepare Attempt'}</button>
            {attemptRejectedKey && <button type="button" className="btn" disabled={preparingAttempt} onClick={() => { resetIdempotencyRecord(localStorage, attemptRejectedKey); setAttemptRejectedKey(''); setAttemptError('Rejected preparation reset. Submit again to use a new key.') }}>Reset rejected request</button>}
          </div>
        </form>}
        {attemptsLoading && attempts.length === 0 && <p className="muted" role="status">Loading attempts…</p>}
        {attemptsError && <p className="notice" role="alert">Could not load attempts: {attemptsError}</p>}
        {sortedAttempts.map((attempt, index) => {
          const key = attemptKey(attempt, index)
          const sessionId = sessionFor(attempt)
          return <article className="mini-row" key={key}>
            <strong>Attempt {text(attempt.ordinal ?? attempt.attempt ?? attempt.attempt_number ?? index + 1)} · {text(attempt.lifecycle?.state ?? attempt.lifecycle ?? attempt.state ?? attempt.status)}</strong>
            {attempt.model && <p>Model · {text(attempt.model)}</p>}
            <p>{text(attempt.started_at)}{(attempt.ended_at ?? attempt.finished_at) ? ` — ${text(attempt.ended_at ?? attempt.finished_at)}` : ''}</p>
            {(attempt.failure || attempt.failure_reason || attempt.error) && <p>Recorded failure: {text(attempt.failure?.summary ?? attempt.failure ?? attempt.failure_reason ?? attempt.error)}</p>}
            {sessionId && <a className="example-link" href={`/sessions?id=${encodeURIComponent(sessionId)}`}>Open bound session · {sessionId}</a>}
            <button type="button" className="text-link" aria-pressed={selectedAttemptKey === key} onClick={() => setSelectedAttemptKey(key)}>Use this attempt</button>
          </article>
        })}
        {!attemptsLoading && !attemptsError && attempts.length === 0 && <p className="muted">No attempts are recorded.</p>}
        {attemptsMore && <button type="button" className="btn" onClick={loadNextAttempts} disabled={attemptsLoading}>{attemptsLoading ? 'Loading…' : 'Load next attempts'}</button>}
      </Panel>}

      {(tab === 'activity' || tab === 'diff') && <SessionPanel kind={tab} sessionId={selectedSessionId} state={sessionData[`${selectedSessionId}:${tab}`]} />}
    </div>
  </aside>
}

function attemptKey(attempt, index) {
  return String(attempt?.id ?? attempt?.attempt_id ?? attempt?.attempt ?? attempt?.attempt_number ?? index)
}

function SessionPanel({ kind, sessionId, state }) {
  const label = kind === 'activity' ? 'Session activity' : 'Session diff'
  if (!sessionId) return <Panel title={label}><p className="muted">No validated session is bound to the selected attempt.</p></Panel>
  if (!state || state.loading) return <Panel title={label}><p className="muted" role="status">Loading {kind}…</p></Panel>
  if (state.error) return <Panel title={label}><p className="notice" role="alert">Could not load {kind}: {state.error}</p></Panel>
  if (kind === 'activity') {
    const events = getEvents(state.value)
    return <Panel title={`Activity · ${sessionId}`}>
      {events.length ? events.map((event, index) => <article className="mini-row" key={event.id ?? index}>
        <strong>{text(event.kind ?? event.type ?? 'Activity')}{event.title || event.tool ? ` · ${text(event.title ?? event.tool)}` : ''}</strong>
        {event.timestamp && <p>{text(event.timestamp)}</p>}
        {event.detail && <p>{text(event.detail)}</p>}
        {event.message && <p>{text(event.message)}</p>}
        {!event.detail && !event.message && event.payload != null && <JsonValue value={event.payload}/>}
      </article>) : <p className="muted">No activity events are recorded.</p>}
    </Panel>
  }
  const diff = getDiffEntries(state.value)
  return <Panel title={`Diff · ${sessionId}`}>
    {diff.length ? diff.map((entry, index) => <article className="mini-row" key={entry.path ?? entry.file ?? index}>
      <strong>{text(entry.path ?? entry.file ?? entry.name ?? `Diff entry ${index + 1}`)}</strong>
      {entry.status && <p>{text(entry.status)}</p>}
      <JsonValue value={entry.patch ?? entry.diff ?? entry.content ?? entry}/>
    </article>) : <p className="muted">No diff available</p>}
  </Panel>
}
