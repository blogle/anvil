'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { request } from './api'
import CommissionInspector from './workbench-inspector'
import CampaignsPanel, { CampaignInspector } from './workbench-campaigns'
import OperationsPanel from './workbench-operations'
import ProviderSettings from './provider-settings'
import SessionDetail from './session-detail'

const recordedFocus = item => item.task?.operator_hold === true || item.attempt?.state === 'failed' || item.commission?.start_authorized === false
const text = value => value == null || value === '' ? 'Not reported' : String(value)
const stateOf = item => item.commission?.state ?? item.task?.state ?? item.attempt?.state ?? 'Not reported'
const integratedAt = item => item.commission?.integrated_at ?? item.commission?.integration?.integrated_at ?? null
const href = (path, id) => id ? `${path}?id=${encodeURIComponent(id)}` : path

export default function Workbench() {
  const pathname = usePathname()
  const router = useRouter()
  const params = useSearchParams()
  const route = params.get('view') === 'settings' ? 'settings' : params.get('view') === 'operations' ? 'operations' : pathname === '/sessions' ? 'sessions' : pathname === '/campaign' || params.get('view') === 'campaigns' ? 'campaigns' : pathname === '/commission' ? 'inbox' : 'inbox'
  const explicitCommission = params.get('commission') || (pathname === '/commission' ? params.get('id') : '') || ''
  const [defaultCommission, setDefaultCommission] = useState('')
  const selectedCommission = explicitCommission || defaultCommission
  const selectedCampaign = params.get('campaign') || (pathname === '/campaign' ? params.get('id') : '') || ''
  const sessionId = pathname === '/sessions' ? params.get('id') || '' : ''
  const [items, setItems] = useState([])
  const [cursor, setCursor] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('focused')
  const [search, setSearch] = useState('')
  const [repos, setRepos] = useState([])
  const [statuses, setStatuses] = useState([])
  const [expanded, setExpanded] = useState(false)
  const [inspectorWidth, setInspectorWidth] = useState(390)
  const [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsError, setSessionsError] = useState('')
  const requestInFlight = useRef(false)
  const defaultSelectionAttempted = useRef(false)

  const loadInbox = useCallback(async (after = null) => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    setLoading(true); setError('')
    try {
      const response = await request(`/inbox?limit=20${after ? `&after=${encodeURIComponent(after)}` : ''}`)
      if (response?.schema_version !== 1 || !Array.isArray(response.items)) throw new Error('Inbox response did not match schema version 1.')
      setItems(current => after ? [...current, ...response.items] : response.items)
      setCursor(response.next_cursor || null)
    } catch (value) { setError(value.message) }
    finally { requestInFlight.current = false; setLoading(false) }
  }, [])

  useEffect(() => { loadInbox() }, [loadInbox])
  useEffect(() => {
    if (defaultSelectionAttempted.current || route !== 'inbox' || explicitCommission || !items.length || typeof window === 'undefined' || window.innerWidth <= 1050) return
    const firstFocused = items.find(recordedFocus)
    if (firstFocused) {
      setDefaultCommission(firstFocused.commission_id)
      defaultSelectionAttempted.current = true
    }
  }, [explicitCommission, items, route])
  useEffect(() => {
    let active = true
    setSessionsLoading(true)
    request('/sessions').then(value => {
      if (!active) return
      setSessions(Array.isArray(value) ? value : Array.isArray(value?.sessions) ? value.sessions : [])
      setSessionsError('')
    }).catch(value => { if (active) setSessionsError(value.message) })
      .finally(() => { if (active) setSessionsLoading(false) })
    return () => { active = false }
  }, [])

  const repositories = useMemo(() => [...new Set(items.map(item => item.execution_target?.repository ?? item.task?.repository).filter(Boolean))].sort(), [items])
  const availableStates = useMemo(() => [...new Set(items.map(stateOf).filter(value => value && value !== 'Not reported'))].sort(), [items])
  const matches = item => {
    const needle = search.trim().toLowerCase()
    const rowText = [item.objective, item.commission_id, item.local_key, item.campaign_id, item.execution_target?.repository, item.task?.repository, stateOf(item), item.attempt?.state].filter(Boolean).join(' ').toLowerCase()
    return (!needle || rowText.includes(needle)) && (!repos.length || repos.includes(item.execution_target?.repository ?? item.task?.repository)) && (!statuses.length || statuses.includes(stateOf(item)))
  }
  const candidates = items.filter(item => (mode === 'everything' || recordedFocus(item)) && matches(item))
  const attention = candidates.filter(recordedFocus)
  const integrated = candidates.filter(item => integratedAt(item))
  const chooseCommission = id => { setDefaultCommission(''); router.push(`/?commission=${encodeURIComponent(id)}`) }
  const chooseCampaign = id => router.push(`/campaign?id=${encodeURIComponent(id)}`)
  const closeInspector = () => {
    setDefaultCommission('')
    if (pathname === '/commission') router.push('/')
    else router.push(route === 'campaigns' ? '/?view=campaigns' : route === 'settings' ? '/?view=settings' : route === 'operations' ? '/?view=operations' : '/')
  }
  const selectedItem = items.find(item => item.commission_id === selectedCommission) || (selectedCommission ? { commission_id: selectedCommission } : null)
  const selectedSession = sessions.find(session => session.id === sessionId)

  const nav = [['inbox', '▤', 'Inbox', '/'], ['campaigns', '◇', 'Campaigns', '/campaign'], ['operations', '⌁', 'Operations', '/?view=operations'], ['settings', '⚙', 'Settings', '/?view=settings']]
  const crumb = route === 'sessions' ? 'Sessions' : route === 'campaigns' ? 'Campaigns' : route === 'operations' ? 'Operations' : route === 'settings' ? 'Settings' : selectedCommission ? 'Inbox / Commission' : mode === 'everything' ? 'Inbox / Everything' : 'Inbox / Focused'
  const inspectorVisible = Boolean((selectedCommission && route === 'inbox') || (selectedCampaign && route === 'campaigns') || route === 'settings')

  return <div className={`anvil-app${expanded ? ' workbench-expanded' : ''}`} style={{ '--inspector': `${inspectorWidth}px` }} data-mobile="false" data-settings={String(route === 'settings')} data-inspector-open={String(Boolean(selectedCommission || selectedCampaign || route === 'settings'))} data-inspector-visible={String(inspectorVisible)}>
    <header className="topbar"><div className="brandline"><a className="brand" href="/">Anvil</a><span className="crumbs">/ {crumb}</span></div><div className="docs-links"><a href="https://github.com/blogle/anvil/blob/v0.2.0/docs/index.md" rel="noopener noreferrer" target="_blank">Docs</a><a href="https://github.com/blogle/anvil/blob/v0.2.0/docs/spec.md#user-interface-and-observability-contract" rel="noopener noreferrer" target="_blank">UI contract</a><a href="https://github.com/blogle/anvil/blob/v0.2.0/docs/infra.md" rel="noopener noreferrer" target="_blank">Infrastructure</a></div></header>
    <div className="app-frame">
      <nav className="area-nav" aria-label="Primary application areas"><div className="nav-caption">WORKSPACE</div>{nav.map(([key, icon, label, path]) => <a className="area-link" data-nav={key} aria-current={route === key ? 'page' : undefined} href={path} key={key}><span className="nav-icon" aria-hidden="true">{icon}</span>{label}</a>)}</nav>
      <main className="app-main"><div className="content-layout">
        <section className="primary-view" aria-live="polite">
          {route === 'inbox' && <>
            <div className="view-head"><div><p className="eyebrow">COMMISSION ATTENTION</p><h1>Inbox</h1><p className="sub">Focused shows recorded holds, failed latest attempts, or commissions not recorded as start-authorized.</p></div>{selectedCommission && <label className="resize-control">Inspector <input type="range" min="320" max="560" step="10" value={inspectorWidth} aria-label="Resize inspector" onChange={event => setInspectorWidth(Number(event.target.value))}/></label>}</div>
            <div className="bar"><button className={`btn${mode === 'focused' ? ' primary' : ''}`} aria-pressed={mode === 'focused'} onClick={() => setMode('focused')}>Focused</button><button className={`btn${mode === 'everything' ? ' primary' : ''}`} aria-pressed={mode === 'everything'} onClick={() => setMode('everything')}>Everything</button><input className="search" type="search" placeholder="Search objective, repository, ID or state" aria-label="Search loaded Inbox records" value={search} onChange={event => setSearch(event.target.value)}/><details className="filter-details"><summary className="btn">Filter</summary><div className="filter-pop"><strong>Repository</strong><div className="filter-group">{repositories.map(value => <label key={value}><input type="checkbox" checked={repos.includes(value)} onChange={event => setRepos(current => event.target.checked ? [...current, value] : current.filter(item => item !== value))}/> {value}</label>)}</div><strong>Status</strong><div className="filter-group">{availableStates.map(value => <label key={value}><input type="checkbox" checked={statuses.includes(value)} onChange={event => setStatuses(current => event.target.checked ? [...current, value] : current.filter(item => item !== value))}/> {value}</label>)}</div></div></details></div>
            <div className="filter-chips">{[...repos.map(value => ['repo', value]), ...statuses.map(value => ['state', value])].map(([kind, value]) => <button className="chip" key={`${kind}:${value}`} onClick={() => kind === 'repo' ? setRepos(current => current.filter(item => item !== value)) : setStatuses(current => current.filter(item => item !== value))}>{value} ×</button>)}{(repos.length + statuses.length > 0) && <button className="chip" onClick={() => { setRepos([]); setStatuses([]) }}>Clear all</button>}</div>
            {loading && items.length === 0 && <p className="muted" role="status">Loading Inbox…</p>}{error && <div className="notice" role="alert">Inbox: {error} <button className="btn" onClick={() => loadInbox()}>Retry</button></div>}
            <section className="list-section"><div className="section-title"><h2>{mode === 'focused' ? 'Needs attention' : 'Everything'}</h2><span className="dim">{mode === 'focused' ? `${attention.length} recorded focus items` : `${candidates.length} loaded records`}{cursor ? ' · partial; more pages available' : ''}</span></div><div className="commission-list">{(mode === 'focused' ? attention : candidates).length ? (mode === 'focused' ? attention : candidates).map(item => <button type="button" className="commission-row" key={`${item.commission_id}:${item.local_key}`} aria-current={selectedCommission === item.commission_id ? 'true' : undefined} onClick={() => chooseCommission(item.commission_id)}>
              <span><strong className="row-title">{item.objective || item.local_key || item.commission_id}</strong><span className="row-meta">{item.commission_id} · {item.local_key}</span></span><span><span className="state">{text(stateOf(item))}</span><span className="row-meta">Task {text(item.task?.state)} · Latest attempt {text(item.attempt?.state)}</span></span><span className="row-side"><span className="row-action">Latest attempt</span><span className="row-title">{item.attempt ? `${text(item.attempt.attempt_id)} · ${text(item.attempt.state)}` : 'No attempt recorded'}</span></span>
            </button>) : <div className="empty-state">{loading ? 'Loading records…' : error ? 'Inbox records could not be loaded.' : 'No loaded records match this view and filter.'}</div>}</div></section>
            {mode === 'focused' && <section className="list-section"><div className="section-title"><h2>Recently integrated</h2><span className="dim">{integrated.length ? `${integrated.length} with recorded integration timestamp` : 'Unavailable'}</span></div>{integrated.length ? <div className="commission-list">{integrated.map(item => <button type="button" className="commission-row" key={`integrated:${item.commission_id}`} aria-current={selectedCommission === item.commission_id ? 'true' : undefined} onClick={() => chooseCommission(item.commission_id)}><span><strong className="row-title">{item.objective || item.local_key}</strong><span className="row-meta">{item.commission_id}</span></span><span><span className="state done">Integrated · {text(integratedAt(item))}</span></span><span className="row-side"><span className="row-action">Latest attempt</span><span className="row-title">{text(item.attempt?.state)}</span></span></button>)}</div> : <p className="empty-state">Unavailable: loaded Inbox records do not include an authoritative integrated timestamp.</p>}</section>}
            <p className="dim">Search and filters cover loaded Inbox pages only{cursor ? '; results are partial.' : '.'}</p>{cursor && <button className="btn" disabled={loading} onClick={() => loadInbox(cursor)}>{loading ? 'Loading…' : 'Load 20 more'}</button>}
          </>}
          {route === 'campaigns' && <CampaignsPanel inboxItems={items} inboxCursor={cursor} onSelectCampaign={chooseCampaign} onSelectCommission={chooseCommission}/>}
          {route === 'operations' && <OperationsPanel/>}
          {route === 'settings' && <><div className="view-head"><div><p className="eyebrow">SETTINGS</p><h1>Provider credentials</h1><p className="sub">Manage provider credentials using the operator token.</p></div></div><ProviderSettings/></>}
          {route === 'sessions' && <><div className="view-head"><div><p className="eyebrow">SESSIONS</p><h1>Development sessions</h1><p className="sub">Session state reported by the local API.</p></div></div>{sessionsError && <div className="notice" role="alert">Sessions: {sessionsError}</div>}{sessionsLoading && <p className="muted" role="status">Loading sessions…</p>}{sessionId && (selectedSession ? <SessionDetail key={selectedSession.id} session={selectedSession}/> : !sessionsLoading && <section className="panel"><h2>Session unavailable</h2><p>Session {sessionId} is not present in the current session list.</p></section>)}<section className="list-section"><div className="section-title"><h2>Available sessions</h2></div>{sessions.map(session => <a className="commission-row" key={session.id} href={href('/sessions', session.id)}><span><strong className="row-title">{session.project || session.id}</strong><span className="row-meta">{session.id} · {session.work_branch || 'Branch not reported'}</span></span><span className="state">{session.environment_state || 'Unknown'} / {session.execution_state || 'Unknown'}</span><span className="row-side">Open session ↗</span></a>)}</section></>}
        </section>
        {selectedCommission && route === 'inbox' && <CommissionInspector key={selectedCommission} item={selectedItem} onClose={closeInspector} expanded={expanded} onToggleExpand={() => setExpanded(value => !value)}/>}
        {selectedCampaign && route === 'campaigns' && <aside className="inspector" aria-label="Campaign inspector"><div className="inspector-head"><button className="btn inspector-back" onClick={closeInspector}>← Back</button><div className="inspector-tools"><span className="eyebrow">CAMPAIGN INSPECTOR</span><button className="btn" onClick={() => setExpanded(value => !value)}>{expanded ? 'Collapse workbench' : 'Expand workbench'}</button></div><h2 className="inspector-title">{selectedCampaign}</h2></div><div className="inspector-body"><CampaignInspector key={selectedCampaign} campaignId={selectedCampaign} onSelectCommission={chooseCommission}/></div></aside>}
        {route === 'settings' && <aside className="inspector" aria-label="Effective configuration"><div className="inspector-head"><span className="eyebrow">EFFECTIVE CONFIGURATION</span><h2 className="inspector-title">New workers</h2></div><div className="inspector-body"><section className="panel"><h3>Configuration scope</h3><p className="muted">Provider credentials are versioned and apply to new workers.</p><p className="callout">Existing workers retain their effective configuration. This view does not claim model defaults or settings controls are saved.</p></section></div></aside>}
        {!selectedCommission && !(selectedCampaign && route === 'campaigns') && route !== 'settings' && <aside className="inspector" aria-label="Context inspector" hidden/>}
      </div></main>
    </div>
  </div>
}
