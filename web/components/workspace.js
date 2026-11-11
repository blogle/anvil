'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { getIdempotencyRecord, isDefinitiveRejection, resetIdempotencyRecord, request, validateSubmission } from './api'
import SessionDetail from './session-detail'
import Inbox from './inbox'
import DecisionHistory from './decision-history'

const sample = {
  campaign: { purpose: 'Deliver a bounded, reviewable change.', shared_contracts: [] },
  commissions: [{
    local_key: 'implementation', objective: 'Implement the requested change.', obligations: [{ id: 'quality', version: 1, requirement: 'Change is correct and tested.', acceptance_expectations: ['Targeted checks pass'] }],
    execution_target: { kind: 'git_repository', project: 'anvil', repository: 'https://github.com/example/anvil', base_ref: 'main' },
    budget: { max_attempts: 3, max_continuations_per_reason: 2, max_verifier_cycles: 2, max_ci_retries: 1, max_execution_seconds: 3600 }, start_after: [], integration_after: [],
  }],
}
const href = (path, id) => id ? `${path}?id=${encodeURIComponent(id)}` : path
const pretty = value => JSON.stringify(value, null, 2)

export default function Workspace() {
  const pathname = usePathname(), router = useRouter(), params = useSearchParams()
  const id = params.get('id') || ''
  const [campaigns, setCampaigns] = useState([]), [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false), [sessionsError, setSessionsError] = useState('')
  const [detail, setDetail] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const [json, setJson] = useState(pretty(sample)), [key, setKey] = useState(''), [submitting, setSubmitting] = useState(false)
  const [startKey, setStartKey] = useState(''), [starting, setStarting] = useState(false), [cursor, setCursor] = useState(null)
  const [campaignRejected, setCampaignRejected] = useState(false), [startRejectedKey, setStartRejectedKey] = useState('')
  const section = pathname === '/campaign' ? 'campaign' : pathname === '/commission' ? 'commission' : pathname === '/sessions' ? 'sessions' : 'home'
  const nav = useMemo(() => [['Inbox','/'],['Campaigns','/campaign'],['Commissions','/commission'],['Sessions','/sessions']], [])

  const loadCampaigns = useCallback(async (after) => {
    if (!id || section !== 'campaign' || params.get('view') === 'create') return
    setLoading(true); setError('')
    try {
      const result = await request(`/campaigns/${encodeURIComponent(id)}?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`)
      setDetail(result); setCursor(result.next_page_cursor || null)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [id, section, params])

  const loadCommission = useCallback(async () => {
    if (!id || section !== 'commission') return
    setLoading(true); setError('')
    try { setDetail(await request(`/commissions/${encodeURIComponent(id)}`)) }
    catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [id, section])

  const loadSessions = useCallback(async () => {
    if (section !== 'sessions' && section !== 'home') return
    setSessionsLoading(true)
    try {
      const result = await request('/sessions'); setSessions(Array.isArray(result) ? result : result?.sessions || []); setSessionsError('')
    }
    catch (e) { setSessionsError(e.message) }
    finally { setSessionsLoading(false) }
  }, [section, id])
  useEffect(() => { setDetail(null); setCursor(null); loadCampaigns(); loadCommission(); loadSessions() }, [loadCampaigns, loadCommission, loadSessions])
  useEffect(() => {
    if (section !== 'sessions') return
    const timer = setInterval(loadSessions, 5000)
    return () => clearInterval(timer)
  }, [section, loadSessions])

  const create = async event => {
    event.preventDefault(); setError('')
    let payload
    try { payload = JSON.parse(json) } catch { setError('The submission must be valid JSON.'); return }
    const issues = validateSubmission(payload)
    if (issues.length) { setError(issues.join(' ')); return }
    const payloadText = JSON.stringify(payload)
    const { record, conflict } = getIdempotencyRecord(localStorage, 'anvil-campaign-idempotency-key', payloadText)
    if (conflict) { setError('The uncertain request is retained with its original payload. Reset it explicitly before submitting this revision.'); return }
    const savedKey = record.key
    setKey(savedKey); setSubmitting(true)
    try {
      const result = await request('/campaigns', { method: 'POST', headers: { 'Idempotency-Key': savedKey }, body: JSON.stringify(payload) })
      resetIdempotencyRecord(localStorage, 'anvil-campaign-idempotency-key'); setKey(''); setCampaignRejected(false)
      router.push(href('/campaign', result.campaign_id))
    } catch (e) {
      const rejected = isDefinitiveRejection(e)
      setCampaignRejected(rejected)
      setError(rejected
        ? `${e.message} The server rejected this request; you may reset its key before submitting a revised payload.`
        : `${e.message} The outcome is uncertain. Keep the original key and payload, retry them, or inspect the campaign receipt before taking another action.`)
    }
    finally { setSubmitting(false) }
  }
  const start = async event => {
    event.preventDefault(); setError('')
    const storageKey = `anvil-commission-key-${id}`
    const body = JSON.stringify({ expected_version: Number(detail.version) })
    const { record, conflict } = getIdempotencyRecord(localStorage, storageKey, body)
    if (conflict) { setError('The uncertain start request is retained for its original version. Refresh and reset it explicitly before starting this version.'); return }
    const savedKey = record.key
    setStartKey(savedKey); setStarting(true)
    try {
      await request(`/commissions/${encodeURIComponent(id)}/start`, { method: 'POST', headers: { 'Idempotency-Key': savedKey }, body })
      resetIdempotencyRecord(localStorage, storageKey); setStartKey(''); setStartRejectedKey(''); await loadCommission()
    } catch (e) {
      const rejected = isDefinitiveRejection(e)
      setStartRejectedKey(rejected ? storageKey : '')
      setError(rejected
        ? `${e.message} The server rejected this start request; you may reset its key before starting a revised version.`
        : `${e.message} The outcome is uncertain. Keep the original key and version, retry them, or inspect the Commission receipt before taking another action.`)
    }
    finally { setStarting(false) }
  }

  return <div className="shell">
    <aside className="rail"><a href="/" className="brand"><span className="brand-mark">A</span><span>ANVIL<small>WORK ORCHESTRATION</small></span></a><div className="rail-label">WORKSPACE</div><nav aria-label="Primary navigation">{nav.map(([label,path], i) => <a key={path} href={path} className={(section === ['home','campaign','commission','sessions'][i] ? 'active ' : '') + 'nav-link'}><span className="nav-icon">{['◫','▤','⌘','◷'][i]}</span>{label}</a>)}</nav><div className="rail-bottom"><span className="online-dot"/> Connected to local Anvil API</div></aside>
    <main className="main"><header className="topbar"><div className="crumb">Workspace <span>/</span> <b>{section === 'home' ? 'Inbox' : section[0].toUpperCase()+section.slice(1)}</b></div><span className="local-badge">LOCAL API</span></header>
      <div className="content">
        {section === 'commission' && detail && <DecisionHistory taskId={id}/>}
        {section === 'home' && <Inbox/>}
        {section === 'home' && <><div className="eyebrow">WORKSPACE OVERVIEW</div><h1>Make work <em>legible.</em></h1><p className="lede">Define a Campaign, inspect its Commission contracts, and follow the sessions doing the work.</p><div className="hero-actions"><a className="button primary" href="/campaign?view=create">＋ Create a Campaign</a><a className="button quiet" href="/sessions">View sessions <span>→</span></a></div><div className="overview-grid"><a className="overview-card" href="/campaign?view=create"><span className="card-index">01 / DEFINE</span><strong>Campaigns</strong><p>Submit an intent and its contracts atomically, with explicit dependencies.</p><span className="card-arrow">↗</span></a><a className="overview-card" href="/commission"><span className="card-index">02 / AUTHORIZE</span><strong>Commissions</strong><p>Review a contract and explicitly authorize its start against a version.</p><span className="card-arrow">↗</span></a><a className="overview-card" href="/sessions"><span className="card-index">03 / FOLLOW</span><strong>Sessions</strong><p>See available development sessions and their reported state.</p><span className="card-arrow">↗</span></a></div><section className="recent"><div><span className="eyebrow">CURRENTLY AVAILABLE</span><h2>Sessions</h2></div><a className="text-link" href="/sessions">All sessions →</a>{sessions.length ? <div className="session-strip">{sessions.slice(0,4).map(s => <a href={href('/sessions',s.id)} key={s.id}><span className="online-dot"/>{s.project || s.id}<small>{s.environment_state || 'State unavailable'}</small></a>)}</div> : <p className="muted">{sessionsError || (sessionsLoading ? 'Loading sessions…' : 'No session data returned yet.')}</p>}</section></>}

        {section === 'campaign' && (params.get('view') === 'create' || !id) ? <><div className="eyebrow">CAMPAIGN / NEW</div><h1>Create a <em>Campaign.</em></h1><p className="lede">One atomic submission: shared purpose and one or more Commission contracts. Dependencies refer to local keys within this submission.</p><form onSubmit={create} className="form-panel"><label htmlFor="submission">Submission contract <span>JSON · validated before sending</span></label><textarea id="submission" spellCheck="false" value={json} onChange={e=>setJson(e.target.value)} aria-describedby="json-help"/><div id="json-help" className="hint">Edit the example contract. Keep each commission's local_key unique; dependency arrays can reference any local_key.</div><details className="contract-help"><summary>Contract shape &amp; dependency semantics</summary><p>Each commission needs an <code>execution_target</code>, bounded <code>budget</code>, and at least one versioned obligation. <code>start_after</code> gates start; <code>integration_after</code> gates integration only. Cycles are rejected.</p></details>{error && <div className="notice error" role="alert">{error}</div>}<div className="form-footer"><span className="hint">Key: {key ? 'retained for retry' : 'created and retained until accepted'}</span><button type="button" className="button quiet" disabled={!campaignRejected || submitting} onClick={()=>{resetIdempotencyRecord(localStorage, 'anvil-campaign-idempotency-key'); setKey(''); setCampaignRejected(false); setError('Rejected request reset. Submitting this revision will use a new key.')}}>Reset rejected request</button><button className="button primary" disabled={submitting}>{submitting ? 'Submitting…' : 'Submit Campaign'} <span>→</span></button></div></form></> : <><div className="eyebrow">CAMPAIGN / AGGREGATE</div><h1>Campaign <em>record.</em></h1><p className="lede">A bounded view of the Campaign and its Commission contracts.</p>{loading && <p className="muted">Loading Campaign…</p>}{error && <div className="notice error" role="alert">{error}</div>}{detail && <><div className="record-card"><span className="card-index">CAMPAIGN ID</span><code>{detail.campaign_id}</code><h2>{detail.purpose || 'Campaign'}</h2><div className="record-meta">{detail.total ?? detail.commissions?.length ?? 0} Commissions <span>·</span> Created {detail.created_at || '—'}</div></div><div className="section-heading"><h2>Commission contracts</h2><span>{detail.commissions?.length || 0} in this page</span></div><div className="contract-list">{(detail.commissions || []).map(c=><a className="contract-row" href={href('/commission',c.commission_id)} key={c.commission_id}><span className="status-dot"/><span className="contract-main"><b>{c.local_key}</b><small>{c.objective}</small></span><span className="state-pill">{c.state} · v{c.version}</span><span className="arrow">↗</span></a>)}</div>{cursor && <button className="button quiet" disabled={loading} onClick={()=>loadCampaigns(cursor)}>Load next page →</button>}{!detail.commissions?.length && <p className="muted">No Commissions on this page.</p>}</>}</>}

        {section === 'commission' && <><div className="eyebrow">COMMISSION / INSPECTOR</div><h1>Commission <em>inspector.</em></h1><form className="lookup" onSubmit={e=>{e.preventDefault();router.push(href('/commission',e.currentTarget.elements.id.value))}}><label htmlFor="commission-id">Commission ID</label><input id="commission-id" name="id" defaultValue={id} placeholder="Paste a Commission ID"/><button className="button quiet">Inspect →</button></form>{loading && <p className="muted">Loading contract…</p>}{error && <div className="notice error" role="alert">{error}</div>}{detail && <><div className="record-card"><span className="card-index">{detail.local_key || 'COMMISSION'} · VERSION {detail.version}</span><h2>{detail.objective}</h2><div className="record-meta"><span className="state-pill">{detail.state}</span> {detail.start_authorized ? 'Start authorized' : 'Start not authorized'}</div></div><div className="detail-grid"><section className="data-card"><h3>Contract</h3><dl><dt>Campaign</dt><dd><a href={href('/campaign',detail.campaign_id)}>{detail.campaign_id}</a></dd><dt>Project</dt><dd>{detail.execution_target?.project || '—'}</dd><dt>Repository</dt><dd>{detail.execution_target?.repository || '—'}</dd><dt>Base ref</dt><dd>{detail.execution_target?.base_ref || '—'}</dd><dt>Dependencies</dt><dd>{detail.start_after?.join(', ') || 'None'}</dd><dt>Integration after</dt><dd>{detail.integration_after?.join(', ') || 'None'}</dd><dt>Usage</dt><dd>{detail.usage?.status || 'unavailable'}{detail.usage?.reason ? ` — ${detail.usage.reason}` : ''}</dd></dl></section><section className="data-card"><h3>Obligations</h3>{(detail.obligations || []).map(o=><div className="obligation" key={o.id}><b>{o.id} <small>v{o.version}</small></b><p>{o.requirement}</p><ul>{(o.acceptance_expectations||[]).map(x=><li key={x}>{x}</li>)}</ul></div>)}</section></div>{!detail.start_authorized && <form onSubmit={start} className="start-panel"><div><span className="card-index">EXPLICIT OPERATOR ACTION</span><h3>Authorize start</h3><p>This is a durable state change. The current expected version ({detail.version}) is sent with an idempotency key.</p></div><button type="button" className="button quiet" disabled={startRejectedKey !== `anvil-commission-key-${id}` || starting} onClick={()=>{resetIdempotencyRecord(localStorage, `anvil-commission-key-${id}`); setStartKey(''); setStartRejectedKey(''); setError('Rejected start request reset.')}}>Reset rejected start</button><button className="button primary" disabled={starting}>{starting?'Authorizing…':'Authorize start →'}</button></form>}{(detail.attempts||[]).some(a=>a.session_id) && <section className="data-card session-links"><h3>Linked sessions</h3>{detail.attempts.filter(a=>a.session_id).map(a=><a href={href('/sessions',a.session_id)} key={a.session_id}>{a.session_id} ↗</a>)}</section>}</>}</>}

        {section === 'sessions' && <><div className="eyebrow">SESSIONS / LIVE VIEW</div><h1>Development <em>sessions.</em></h1><p className="lede">Session state reported by the local API. This view refreshes every five seconds.</p>{sessionsError && <div className="notice error" role="alert">{sessionsError}</div>}{id && (sessions.find(session => session.id === id) ? <SessionDetail key={id} session={sessions.find(session => session.id === id)} /> : <section className="data-card" aria-live="polite"><h2>{sessionsLoading ? 'Loading session…' : 'Session unavailable'}</h2><p>{sessionsLoading ? `Looking for session ${id}.` : `Session ${id} is not present in the current session list.`}</p></section>)}<div className="section-heading"><h2>Available sessions</h2><button className="text-link" onClick={loadSessions}>Refresh now ↻</button></div>{sessions.length ? <div className="contract-list">{sessions.map(s=><a className="contract-row session-row" href={href('/sessions',s.id)} key={s.id}><span className="status-dot"/><span className="contract-main"><b>{s.project || s.id}</b><small>{s.id} · {s.work_branch || 'Branch not reported'}</small></span><span className="state-pill">{s.environment_state || 'Unknown'} / {s.execution_state || 'Unknown'}</span><span className="arrow">↗</span></a>)}</div> : <div className="empty"><span>◷</span><h3>{sessionsLoading ? 'Loading sessions…' : 'No sessions returned'}</h3><p>When available, sessions will appear here with their reported environment and execution state.</p></div>}</>}
      </div><footer className="footer"><span>ANVIL / CONTROL PLANE</span><span>Same-origin API · No browser credentials</span></footer></main>
  </div>
}
