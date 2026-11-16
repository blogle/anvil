'use client'

import { useEffect, useMemo, useState } from 'react'
import { getIdempotencyRecord, isDefinitiveRejection, request, resetIdempotencyRecord, validateSubmission } from './api'

const sample = {
  campaign: { purpose: 'Deliver a bounded, reviewable change.', shared_contracts: [] },
  commissions: [{
    local_key: 'implementation', objective: 'Implement the requested change.',
    obligations: [{ id: 'quality', version: 1, requirement: 'Change is correct and tested.', acceptance_expectations: ['Targeted checks pass'] }],
    execution_target: { kind: 'git_repository', project: 'anvil', repository: 'https://github.com/example/anvil', base_ref: 'main' },
    budget: { max_attempts: 3, max_continuations_per_reason: 2, max_verifier_cycles: 2, max_ci_retries: 1, max_execution_seconds: 3600 },
    start_after: [], integration_after: [],
  }],
}

const stringify = value => JSON.stringify(value, null, 2)
const idOf = item => item?.campaign_id
const uniqueCommissions = records => [...new Map(records.map(item => [item.commission_id, item])).values()]
const display = value => value == null || value === '' ? 'Not reported' : String(value)

export default function CampaignsPanel({ inboxItems = [], onSelectCommission, onSelectCampaign, inboxCursor }) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const [json, setJson] = useState(stringify(sample))
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [key, setKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [rejected, setRejected] = useState(false)

  const campaigns = useMemo(() => {
    const grouped = new Map()
    for (const item of Array.isArray(inboxItems) ? inboxItems : []) {
      const campaignId = idOf(item)
      if (!campaignId) continue
      if (!grouped.has(campaignId)) grouped.set(campaignId, [])
      grouped.get(campaignId).push(item)
    }
    const query = search.trim().toLowerCase()
    return [...grouped].map(([campaignId, records]) => ({ campaignId, records, commissions: uniqueCommissions(records) }))
      .filter(({ campaignId, records, commissions }) => !query || [campaignId, ...records.map(record => record.objective), ...commissions.map(item => item.local_key)].some(value => String(value || '').toLowerCase().includes(query)))
  }, [inboxItems, search])

  const chooseCampaign = campaignId => {
    setSelected(campaignId)
    onSelectCampaign?.(campaignId)
  }

  const submit = async event => {
    event.preventDefault()
    setError(''); setNotice('')
    let payload
    try { payload = JSON.parse(json) } catch { setError('The submission must be valid JSON.'); return }
    const issues = validateSubmission(payload)
    if (issues.length) { setError(issues.join(' ')); return }
    const payloadText = JSON.stringify(payload)
    const storageKey = 'anvil-campaign-idempotency-key'
    const { record, conflict } = getIdempotencyRecord(localStorage, storageKey, payloadText)
    if (conflict) { setError('The uncertain request is retained with its original payload. Reset it explicitly before submitting this revision.'); return }
    setKey(record.key); setSubmitting(true)
    try {
      const result = await request('/campaigns', { method: 'POST', headers: { 'Idempotency-Key': record.key }, body: payloadText })
      resetIdempotencyRecord(localStorage, storageKey); setKey(''); setRejected(false)
      setNotice('Campaign submitted successfully.')
      if (result?.campaign_id) chooseCampaign(result.campaign_id)
    } catch (e) {
      const definitive = isDefinitiveRejection(e)
      setRejected(definitive)
      setError(definitive
        ? `${e.message} The server rejected this request; you may reset its key before submitting a revised payload.`
        : `${e.message} The outcome is uncertain. Keep the original key and payload, retry them, or inspect the campaign receipt before taking another action.`)
    } finally { setSubmitting(false) }
  }

  const resetRejected = () => {
    resetIdempotencyRecord(localStorage, 'anvil-campaign-idempotency-key')
    setKey(''); setRejected(false); setError(''); setNotice('Rejected request reset. Submitting this revision will use a new key.')
  }

  return <section className="workbench-campaigns">
    <div className="view-head"><div><p className="eyebrow">APPROVED OBJECTIVES</p><h1>Campaigns</h1><p className="sub">Campaign records represented by the Inbox pages loaded by the parent.</p></div></div>
    <div className="toolbar"><input className="search" type="search" aria-label="Search Campaigns" placeholder="Search Campaigns, objectives, Commissions" value={search} onChange={event => setSearch(event.target.value)}/></div>
    <div className="list-section">
      <div className="section-title"><h2>Campaign list</h2><span className="dim">{campaigns.length} represented · partial, derived only from loaded Inbox records{inboxCursor ? ' · more Inbox pages available' : ''}</span></div>
      <div className="commission-list">
        {campaigns.length ? campaigns.map(({ campaignId, records, commissions }) => <button type="button" className="commission-row campaign-row" key={campaignId} data-campaign={campaignId} aria-current={selected === campaignId ? 'true' : 'false'} onClick={() => chooseCampaign(campaignId)}>
          <span><strong className="row-title">{campaignId}</strong><span className="row-meta">{records.find(item => item.objective)?.objective || 'Purpose not present in Inbox records'}</span></span>
          <span><span className="state">{commissions.length} distinct Commission{commissions.length === 1 ? '' : 's'} represented</span><span className="row-meta">{records.length} loaded Inbox record{records.length === 1 ? '' : 's'}</span></span>
          <span className="row-side"><span className="row-action">Observed scope</span><span className="row-title">Loaded Inbox records only</span></span>
        </button>) : <div className="empty-state">{search ? 'No represented Campaigns match this search.' : 'No Campaigns are represented in the loaded Inbox records.'}</div>}
      </div>
    </div>
    {selected && !onSelectCampaign && <CampaignInspector campaignId={selected} onSelectCommission={onSelectCommission} onClose={() => setSelected('')}/>}
    <section className="panel campaign-create">
      <h2>Create Campaign</h2><p className="muted">Submit one Campaign purpose and its Commission contracts as a validated JSON document.</p>
      <form onSubmit={submit} className="mock-form">
        <label htmlFor="campaign-submission">Submission contract <span>JSON · validated before sending</span></label>
        <textarea id="campaign-submission" spellCheck="false" value={json} onChange={event => setJson(event.target.value)} aria-describedby="campaign-json-help"/>
        <div id="campaign-json-help" className="hint">Commission dependency arrays refer to local keys within this submission. Start and integration dependencies remain distinct.</div>
        <details><summary>Contract shape &amp; dependency semantics</summary><p>Each Commission needs an execution target, bounded budget, and at least one versioned obligation. <code>start_after</code> gates start; <code>integration_after</code> gates integration only.</p></details>
        {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}
        <div className="form-footer"><span className="hint">{key ? 'Idempotency key retained for retry' : 'Idempotency key is retained until accepted'}</span><button type="button" className="button quiet" disabled={!rejected || submitting} onClick={resetRejected}>Reset rejected request</button><button className="button primary" disabled={submitting}>{submitting ? 'Submitting…' : 'Submit Campaign'} <span>→</span></button></div>
      </form>
    </section>
  </section>
}

export function CampaignInspector({ campaignId, onSelectCommission, onClose }) {
  const [detail, setDetail] = useState(null)
  const [cursor, setCursor] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let current = true
    setDetail(null); setCursor(null); setError('')
    if (!campaignId) return () => { current = false }
    setLoading(true)
    request(`/campaigns/${encodeURIComponent(campaignId)}?limit=50`)
      .then(result => { if (current) { setDetail(result); setCursor(result?.next_page_cursor || null) } })
      .catch(e => { if (current) setError(e.message) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [campaignId, retry])

  const loadMore = async () => {
    if (!cursor || loading) return
    setLoading(true); setError('')
    try {
      const page = await request(`/campaigns/${encodeURIComponent(campaignId)}?limit=50&after=${encodeURIComponent(cursor)}`)
      setDetail(current => ({
        ...current,
        ...page,
        campaign: page?.campaign || current?.campaign,
        purpose: page?.purpose ?? current?.purpose,
        shared_contracts: page?.shared_contracts ?? current?.shared_contracts,
        commissions: [...(current?.commissions || []), ...(page?.commissions || [])],
      }))
      setCursor(page?.next_page_cursor || null)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }

  const campaign = detail?.campaign || {}
  const commissions = Array.isArray(detail?.commissions) ? detail.commissions : []
  const purpose = detail?.purpose ?? campaign.purpose
  const sharedContracts = detail?.shared_contracts ?? campaign.shared_contracts
  const contracts = Array.isArray(sharedContracts) ? sharedContracts : []
  return <section className="panel campaign-inspector" aria-label="Campaign inspector">
    <div className="inspector-tools"><span className="eyebrow">CAMPAIGN INSPECTOR</span>{onClose && <button type="button" className="btn" onClick={onClose}>Close</button>}</div>
    <h2 className="inspector-title">{campaignId}</h2>
    {loading && !detail && <p className="muted" role="status">Loading Campaign…</p>}
    {error && <div className="notice error" role="alert">{error} <button type="button" className="text-link" onClick={() => { setCursor(null); setDetail(null); setError(''); setRetry(value => value + 1) }}>Retry</button></div>}
    {detail && <>
      <div className="panel"><h3>Campaign purpose</h3><p>{display(purpose)}</p><p className="muted">Campaign purpose and shared contracts are returned by the Campaign API.</p></div>
      <div className="panel"><h3>Shared contracts</h3>{contracts.length ? contracts.map((contract, index) => <pre className="diff" key={contract?.id || contract?.name || index}>{stringify(contract)}</pre>) : <p className="muted">No shared contracts returned.</p>}</div>
      <div className="panel"><h3>Commissions · flat list</h3>{commissions.length ? commissions.map((commission, index) => <div className="data-row" key={commission.commission_id || commission.id || commission.local_key || index}>
        {onSelectCommission ? <button type="button" className="text-link" onClick={() => onSelectCommission(commission.commission_id || commission.id)}>{commission.objective || commission.local_key || commission.commission_id || commission.id || 'Commission'}</button> : <strong>{commission.objective || commission.local_key || commission.commission_id || commission.id || 'Commission'}</strong>}
        <span className="row-meta">Start after: {commission.start_after?.join(', ') || 'none'} · Integration after: {commission.integration_after?.join(', ') || 'none'}</span>
      </div>) : <p className="muted">No Commission contracts returned.</p>}</div>
      {cursor && <div className="inbox-more"><button type="button" className="button quiet" disabled={loading} onClick={loadMore}>{loading ? 'Loading…' : 'Load more Commissions'}</button><span className="hint">Additional Campaign pages have not been loaded.</span></div>}
      {!cursor && <p className="hint">{commissions.length} Commissions returned across the pages loaded.</p>}
    </>}
  </section>
}
